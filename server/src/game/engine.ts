// 權威遊戲引擎（MVP 核心循環）
// 覆蓋：發牌、摸牌公開、自摸/放槍胡牌、吃牌、打牌、換人、流局。
// 尚未實作（保留擴充點）：死牌先進先出、聽牌宣告、抽五隻、胡開、依顏色計分、一炮多響。
//
// 吃牌規則（依需求）：
//  - 只有「有人能吃/胡」時才開吃牌窗；沒人能吃就直接進棄牌、換下一位。
//  - 吃/胡在窗開著時隨時可按。
//  - 下一家要「兩秒後且無人宣告」才可以摸牌；即使超過兩秒，只要下一家還沒摸牌，仍可按吃。
//  - 吃是「暫定」的：吃牌者尚未打出前，優先權更高的玩家仍可按吃搶走，低優先者讓出。
//    依座位順序決定優先（胡 > 吃、下家優先）。

import {
  buildDeck,
  shuffle,
  isPair,
  isWinningSet,
  hasMatch,
  type Card,
} from '@nine-cards/shared';
import type {
  ActionType,
  PersonalGameState,
  PublicPlayer,
  RoomPhase,
} from '@nine-cards/shared';

export interface SeatInit {
  id: string;
  name: string;
}

interface EnginePlayer {
  id: string;
  name: string;
  seat: number;
  hand: Card[]; // 暗手牌
  melds: Card[][]; // 已公開吃牌對子
  connected: boolean;
  isDealer: boolean;
}

// DRAW：輪到的人摸牌；CLAIM：牌可被吃/胡的時間窗（尚無人持有）；
// EATING：已有人暫定吃牌、待其打出（期間高優先者可搶）；DISCARD：莊家開局打牌。
type Stage = 'DRAW' | 'CLAIM' | 'EATING' | 'DISCARD';

interface Pending {
  card: Card;
  fromSeat: number;
  kind: 'drawn' | 'discard';
}

interface Tentative {
  seat: number;
  meldIndex: number; // 暫定對子在該玩家 melds 中的索引
  match: Card; // 從手牌拿出來配對的那張
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

const DRAW_GAME_FLOOR = 9; // 牌堆剩 9 張仍無人胡則流局（§12）
// 下一家可摸牌前的等待時間（可用環境變數 CLAIM_WINDOW_MS 覆寫，測試用）
export const CLAIM_WINDOW_MS = Number(process.env.CLAIM_WINDOW_MS ?? 5000);

export class GameEngine {
  players: EnginePlayer[];
  deck: Card[] = [];
  discardPile: Card[] = [];
  stage: Stage = 'DRAW';
  turnSeat = 0;
  pending: Pending | null = null;
  phase: RoomPhase = 'PLAYING';
  winnerSeat: number | null = null;
  drawGame = false;
  message: string | null = null;

  // 吃牌窗狀態
  claimOrder: number[] = []; // 依優先順序（胡>吃、下家優先）排好的可宣告座位
  eatHolder: number | null = null; // 目前暫定吃到的人（EATING 時）
  tentative: Tentative | null = null; // 暫定對子資訊，供被搶時還原
  claimId = 0; // 每開一個新窗 +1，供伺服器排程對齊
  claimEndsAt = 0; // 下一家可摸牌的時間點（epoch ms）
  protectedSelfEat = false; // 自摸吃保護：摸牌者可吃/胡自己的牌且無他家能胡 → 不限時、下家不能先摸

  private readonly n: number;

  constructor(seats: SeatInit[], dealerSeat: number, rng: () => number = Math.random) {
    this.n = seats.length;
    this.players = seats.map((s, seat) => ({
      id: s.id,
      name: s.name,
      seat,
      hand: [],
      melds: [],
      connected: true,
      isDealer: seat === dealerSeat,
    }));
    this.deal(dealerSeat, rng);
  }

  // ── 發牌（§5）：莊家 10 張，其餘 9 張 ──────────────────
  private deal(dealerSeat: number, rng: () => number) {
    this.deck = shuffle(buildDeck(), rng);
    for (const p of this.players) {
      const count = p.seat === dealerSeat ? 10 : 9;
      p.hand = this.deck.splice(0, count);
      this.sortHand(p);
    }
    this.turnSeat = dealerSeat;
    if (isWinningSet(this.ownedCards(this.players[dealerSeat]))) {
      this.win(dealerSeat, '天胡');
    } else {
      this.stage = 'DISCARD'; // 莊家先打一張（不摸牌）
      this.message = `${this.players[dealerSeat].name} 開局（莊家先打）`;
    }
  }

  private sortHand(p: EnginePlayer) {
    p.hand.sort((a, b) => a.id.localeCompare(b.id));
  }

  private ownedCards(p: EnginePlayer): Card[] {
    return [...p.hand, ...p.melds.flat()];
  }

  private nextSeat(seat: number): number {
    return (seat + 1) % this.n;
  }

  private clockwiseDistance(fromSeat: number, seat: number, includeSelf: boolean): number {
    if (seat === fromSeat) return includeSelf ? 0 : Infinity;
    return (seat - fromSeat + this.n) % this.n;
  }

  private priorityIndex(seat: number): number {
    return this.claimOrder.indexOf(seat);
  }

  private canWinWithPending(seat: number): boolean {
    if (!this.pending) return false;
    return isWinningSet([...this.ownedCards(this.players[seat]), this.pending.card]);
  }

  private canEatPending(seat: number): boolean {
    if (!this.pending) return false;
    return hasMatch(this.players[seat].hand, this.pending.card);
  }

  // ── 開吃牌窗；沒有任何人能吃/胡就直接進棄牌、換下一位 ──
  private startClaim(includeOfferer: boolean) {
    const card = this.pending!.card;
    const fromSeat = this.pending!.fromSeat;
    const kind = this.pending!.kind;
    const winners: number[] = [];
    const eaters: number[] = [];
    for (const p of this.players) {
      if (p.seat === fromSeat && !includeOfferer) continue;
      if (isWinningSet([...this.ownedCards(p), card])) winners.push(p.seat);
      else if (hasMatch(p.hand, card)) eaters.push(p.seat);
    }
    const byDistance = (a: number, b: number) =>
      this.clockwiseDistance(fromSeat, a, includeOfferer) -
      this.clockwiseDistance(fromSeat, b, includeOfferer);
    winners.sort(byDistance);
    eaters.sort(byDistance);
    this.claimOrder = [...winners, ...eaters];
    this.eatHolder = null;
    this.tentative = null;
    this.protectedSelfEat = false;

    if (this.claimOrder.length === 0) {
      this.resolveNoClaim(); // 沒人能吃 → 直接落桌、換人
      return;
    }
    this.stage = 'CLAIM';
    this.claimId++;

    // 自摸吃保護：摸牌者能吃/胡自己摸的牌，且沒有其他家能胡 → 不限時、下家不能先摸
    const drawerCanClaim = winners.includes(fromSeat) || eaters.includes(fromSeat);
    const otherHu = winners.some((s) => s !== fromSeat);
    if (kind === 'drawn' && drawerCanClaim && !otherHu) {
      this.protectedSelfEat = true;
      this.claimEndsAt = Number.MAX_SAFE_INTEGER; // 不限時
      return;
    }
    this.claimEndsAt = Date.now() + CLAIM_WINDOW_MS;
  }

  private formTentativeEat(seat: number) {
    const card = this.pending!.card;
    const p = this.players[seat];
    const matchIdx = p.hand.findIndex((c) => isPair(c, card));
    const [match] = p.hand.splice(matchIdx, 1);
    p.melds.push([match, card]); // 暫定公開對子
    this.tentative = { seat, meldIndex: p.melds.length - 1, match };
    this.eatHolder = seat;
    this.protectedSelfEat = false;
    this.turnSeat = seat; // 由吃牌者打一張（§7.3）
    this.stage = 'EATING';
    this.message = `${p.name} 吃 ${card.color}${card.rank}`;
  }

  private undoTentativeEat() {
    if (!this.tentative) return;
    const { seat, meldIndex, match } = this.tentative;
    const p = this.players[seat];
    p.melds.splice(meldIndex, 1); // 暫定對子一定是最後一個
    p.hand.push(match);
    this.sortHand(p);
    this.tentative = null;
    this.eatHolder = null;
  }

  private clearClaim() {
    this.claimOrder = [];
    this.eatHolder = null;
    this.tentative = null;
    this.claimEndsAt = 0;
    this.protectedSelfEat = false;
  }

  // ── 對外：某玩家此刻可做的動作 ─────────────────────────
  legalActionsFor(seat: number): ActionType[] {
    if (this.phase === 'FINISHED') return [];
    if (this.stage === 'DRAW') {
      return seat === this.turnSeat ? ['draw'] : [];
    }
    if (this.stage === 'DISCARD') {
      if (seat !== this.turnSeat) return [];
      const acts: ActionType[] = ['discard'];
      if (isWinningSet(this.ownedCards(this.players[seat]))) acts.unshift('declareWin');
      return acts;
    }
    if (this.stage === 'EATING') {
      // 持有者要打牌；優先權更高者仍可搶吃/胡
      if (seat === this.eatHolder) {
        const acts: ActionType[] = ['discard'];
        if (isWinningSet(this.ownedCards(this.players[seat]))) acts.unshift('declareWin');
        return acts;
      }
      const acts: ActionType[] = [];
      if (
        this.eatHolder !== null &&
        this.claimOrder.includes(seat) &&
        this.priorityIndex(seat) < this.priorityIndex(this.eatHolder)
      ) {
        if (this.canWinWithPending(seat)) acts.push('declareWin');
        if (this.canEatPending(seat)) acts.push('eat');
      }
      return acts;
    }
    // CLAIM
    const acts: ActionType[] = [];
    // 自摸吃保護：只有摸牌者能行動（吃/胡不限時；或「不吃」打出摸到的牌），他家與下家都要等
    if (this.protectedSelfEat) {
      if (this.pending && seat === this.pending.fromSeat) {
        if (this.canWinWithPending(seat)) acts.push('declareWin');
        if (this.canEatPending(seat)) acts.push('eat');
        acts.push('pass'); // 不吃 = 打出摸到的牌
      }
      return acts;
    }
    // 一般吃牌窗：可吃/胡；下一家「兩秒後」可摸牌關窗
    if (this.claimOrder.includes(seat)) {
      if (this.canWinWithPending(seat)) acts.push('declareWin');
      if (this.canEatPending(seat)) acts.push('eat');
    }
    if (
      this.pending &&
      seat === this.nextSeat(this.pending.fromSeat) &&
      Date.now() >= this.claimEndsAt
    ) {
      acts.push('draw');
    }
    return acts;
  }

  // ── 套用玩家動作 ───────────────────────────────────────
  apply(playerId: string, action: ActionType, cardId?: string): ApplyResult {
    if (this.phase === 'FINISHED') return { ok: false, error: '牌局已結束' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: '找不到玩家' };
    if (!this.legalActionsFor(p.seat).includes(action)) {
      return { ok: false, error: '現在無法執行此動作' };
    }
    switch (action) {
      case 'draw':
        return this.doDraw(p);
      case 'discard':
        return this.doDiscard(p, cardId);
      case 'eat':
        return this.doEatClaim(p.seat);
      case 'declareWin':
        return this.doDeclareWin(p);
      case 'pass':
        return this.doPass(p);
      default:
        return { ok: false, error: '未知動作' };
    }
  }

  private doDraw(p: EnginePlayer): ApplyResult {
    // 下一家在兩秒後摸牌 → 關閉吃牌窗（沒按吃者當過牌），原牌落桌
    if (this.stage === 'CLAIM') {
      this.clearClaim();
      this.resolveNoClaim();
      if (String(this.stage) !== 'DRAW' || this.turnSeat !== p.seat) return { ok: true };
    }
    if (this.deck.length <= DRAW_GAME_FLOOR) {
      this.drawGame = true;
      this.phase = 'FINISHED';
      this.winnerSeat = null;
      this.message = '流局（牌堆已到底）';
      return { ok: true };
    }
    const card = this.deck.shift()!;
    this.pending = { card, fromSeat: p.seat, kind: 'drawn' };
    this.message = `${p.name} 摸到 ${card.color}${card.rank}`;
    this.startClaim(true); // 摸到的牌公開，含自摸者都可宣告
    return { ok: true };
  }

  // 打牌：莊家開局（DISCARD）或吃牌者出牌（EATING，提交吃牌）都走這裡
  private doDiscard(p: EnginePlayer, cardId?: string): ApplyResult {
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return { ok: false, error: '手牌中沒有這張牌' };
    const [card] = p.hand.splice(idx, 1);
    // 提交暫定吃牌（對子成為正式），清掉暫定狀態
    this.tentative = null;
    this.eatHolder = null;
    this.pending = { card, fromSeat: p.seat, kind: 'discard' };
    this.message = `${p.name} 打出 ${card.color}${card.rank}`;
    this.startClaim(false); // 打出的牌只有其他玩家能吃/胡（放槍）
    return { ok: true };
  }

  // 按吃：成為（或搶下）暫定吃牌者
  private doEatClaim(seat: number): ApplyResult {
    if (this.stage !== 'CLAIM' && this.stage !== 'EATING') {
      return { ok: false, error: '現在沒有可吃的牌' };
    }
    if (
      this.eatHolder !== null &&
      this.priorityIndex(seat) >= this.priorityIndex(this.eatHolder)
    ) {
      return { ok: false, error: '優先權不足，無法搶吃' };
    }
    if (this.eatHolder !== null) this.undoTentativeEat(); // 還原被搶者
    this.formTentativeEat(seat);
    return { ok: true };
  }

  private doDeclareWin(p: EnginePlayer): ApplyResult {
    if ((this.stage === 'CLAIM' || this.stage === 'EATING') && this.pending) {
      if (this.eatHolder !== null) this.undoTentativeEat(); // 胡牌優先，撤銷暫定吃
      const card = this.pending.card;
      p.hand.push(card);
      this.sortHand(p);
      const selfDraw = this.pending.kind === 'drawn' && p.seat === this.pending.fromSeat;
      this.pending = null;
      this.clearClaim();
      this.win(p.seat, selfDraw ? '自摸' : '胡（放槍）');
      return { ok: true };
    }
    if (this.stage === 'DISCARD' && isWinningSet(this.ownedCards(p))) {
      this.win(p.seat, '胡');
      return { ok: true };
    }
    return { ok: false, error: '目前無法胡牌' };
  }

  // 摸牌者放棄自摸吃（「不吃」）：其他能吃的人改用限時窗；沒有就直接落桌、換下一位
  private doPass(p: EnginePlayer): ApplyResult {
    if (!this.protectedSelfEat || this.stage !== 'CLAIM' || p.seat !== this.pending?.fromSeat) {
      return { ok: false, error: '現在無法執行此動作' };
    }
    this.protectedSelfEat = false;
    this.claimOrder = this.claimOrder.filter((s) => s !== p.seat);
    if (this.claimOrder.length > 0) {
      // 還有他家能吃這張摸出的牌 → 轉為限時窗，下家兩秒後可摸牌
      this.stage = 'CLAIM';
      this.claimId++;
      this.claimEndsAt = Date.now() + CLAIM_WINDOW_MS;
      return { ok: true };
    }
    this.clearClaim();
    this.resolveNoClaim(); // 沒人要 → 摸到的牌落桌、換下一位
    return { ok: true };
  }

  // 無人宣告 → 待宣告的牌進棄牌區（落在桌面），換下一位摸牌（§6.5/§6.6）
  private resolveNoClaim() {
    if (this.pending) {
      this.discardPile.push(this.pending.card);
      const from = this.pending.fromSeat;
      this.pending = null;
      this.turnSeat = this.nextSeat(from);
    }
    this.stage = 'DRAW';
  }

  private win(seat: number, reason: string) {
    this.winnerSeat = seat;
    this.phase = 'FINISHED';
    this.stage = 'DISCARD';
    this.pending = null;
    this.clearClaim();
    this.message = `${this.players[seat].name} ${reason}胡牌！`;
  }

  setConnected(playerId: string, connected: boolean) {
    const p = this.players.find((x) => x.id === playerId);
    if (p) p.connected = connected;
  }

  // ── 為單一玩家產生個人化視圖（隱藏他人暗牌）──────────
  viewFor(playerId: string): PersonalGameState {
    const me = this.players.find((x) => x.id === playerId)!;
    const publicPlayers: PublicPlayer[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      handCount: p.hand.length,
      melds: p.melds,
      connected: p.connected,
      isDealer: p.isDealer,
    }));
    const lastDrawn =
      this.pending && this.pending.kind === 'drawn' && this.stage === 'CLAIM'
        ? { seat: this.pending.fromSeat, card: this.pending.card }
        : null;
    const pendingClaim =
      this.stage === 'CLAIM' && this.pending
        ? { card: this.pending.card, fromSeat: this.pending.fromSeat }
        : null;
    return {
      roomId: '',
      phase: this.phase,
      players: publicPlayers,
      you: { id: me.id, seat: me.seat, hand: me.hand, melds: me.melds },
      deckCount: this.deck.length,
      discardPile: this.discardPile,
      currentTurnSeat: this.turnSeat,
      lastDrawn,
      pendingClaim,
      // 自摸保護時不限時 → 不送倒數（前端不顯示倒數條）
      claimEndsAt: this.stage === 'CLAIM' && !this.protectedSelfEat ? this.claimEndsAt : null,
      legalActions: this.legalActionsFor(me.seat),
      winnerSeat: this.winnerSeat,
      message: this.message,
    };
  }
}
