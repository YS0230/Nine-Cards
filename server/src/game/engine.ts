// 權威遊戲引擎（MVP 核心循環）
// 覆蓋：發牌、摸牌公開、自摸/放槍胡牌、吃牌、打牌、換人（逆時鐘）、流局、
//       死牌先進先出、聽牌宣告、依顏色計分、胡開、胡牌者手動抽五隻。
//
// 吃牌規則（依需求）：
//  - 只有「有人能吃/胡」時才開吃牌窗；沒人能吃就直接進棄牌、換下一位。
//  - 吃/胡在窗開著時隨時可按。
//  - 下一家要「兩秒後且無人宣告」才可以摸牌；即使超過兩秒，只要下一家還沒摸牌，仍可按吃。
//  - 吃是「暫定」的：吃牌者尚未打出前，優先權更高的玩家仍可按吃搶走，低優先者讓出。
//    依座位順序決定優先（胡 > 吃、下家優先）。
//  - 自摸最高優先：多家聽同一張時，摸牌者能胡自己摸的牌 → 由摸牌者先決定（不限時），
//    他家要等摸牌者胡／吃／不吃之後才有機會宣告。

import {
  buildDeck,
  shuffle,
  isPair,
  isWinningSet,
  isTenpai,
  hasMatch,
  colorScore,
  huKaiBonus,
  kindKey,
  cardDrawStrength,
  type Card,
} from '@nine-cards/shared';
import type {
  ActionType,
  DrawFiveView,
  GameOverPayload,
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
  hand: Card[]; // 暗手牌（死牌也仍留在 hand，另以 deadIds 標記並公開）
  melds: Card[][]; // 已公開吃牌對子
  deadIds: string[]; // 死牌在 hand 中的 id，FIFO 順序（§7.2/7.3）
  connected: boolean;
  isDealer: boolean;
  score: number; // 本場累計頭數（由 gameServer 跨局維護，viewFor 帶出）
}

// 胡牌時據以計分的情境（§9.2 抽五隻資格、§10.1 胡開）
interface WinContext {
  winningCard?: Card | null; // 胡的那張（天胡／開手胡為 null）
  loserSeat?: number | null; // 放槍者（只有他付）；null = 自摸/摸牌胡，全體付
  handBefore?: Card[]; // 加入胡牌張之前的暗手牌（供胡開判定）
  selfDraw?: boolean; // 自摸（胡自己摸的牌）→ 加一頭
}

// DEAL_DRAW：開局各玩家自己抽一張決定莊家（§4.1）；DRAW：輪到的人摸牌；
// CLAIM：牌可被吃/胡的時間窗（尚無人持有）；
// EATING：已有人暫定吃牌、待其打出（期間高優先者可搶）；DISCARD：莊家開局打牌；
// DRAW_FIVE：胡牌後由胡牌者手動一張一張抽五隻（§9.2），抽完才結算。
type Stage = 'DEAL_DRAW' | 'DRAW' | 'CLAIM' | 'EATING' | 'DISCARD' | 'DRAW_FIVE';

// 胡牌後手動抽五隻（§9.2）的進行狀態
interface DrawFiveState {
  winnerSeat: number;
  winningCard: Card;
  kinds: Set<string>; // 胡牌者牌組（五對）的牌種：抽中任一種即加頭
  entries: { card: Card; qualifying: boolean; heads: number }[];
}

// 進入抽五隻前先算好、與抽牌無關的計分片段，抽完後組裝最終結算
interface PendingWin {
  seat: number;
  label: string;
  color: number; // §11 顏色頭數
  huKai: number; // §10.1 胡開頭數
  selfDraw: number; // 自摸加頭（自摸 1、否則 0）
  loserSeat: number | null; // 放槍者（抽五隻情境固定為 null）
  winningCard: Card | null; // 胡的那張（結算畫面顯示用）
}

interface Pending {
  card: Card;
  fromSeat: number;
  kind: 'drawn' | 'discard';
}

interface Tentative {
  seat: number;
  meldIndex: number; // 暫定對子在該玩家 melds 中的索引
  match: Card; // 從手牌拿出來配對的那張
  matchWasDead: boolean; // 配對牌原本是死牌（被搶時需還原死牌狀態）
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

const DRAW_GAME_FLOOR = 9; // 牌堆剩 9 張仍無人胡則流局（§12）
// 下一家可摸牌前的等待時間「預設值」（可用環境變數 CLAIM_WINDOW_MS 覆寫，測試用）；
// 實際每房可於建房時選擇秒數（EngineOptions.claimWindowMs）
export const CLAIM_WINDOW_MS = Number(process.env.CLAIM_WINDOW_MS ?? 5000);

export interface EngineOptions {
  hints?: boolean; // 新手提示（預設開）
  claimWindowMs?: number; // 吃牌窗等待毫秒（預設 CLAIM_WINDOW_MS）
}
// 決定莊家後、面板停留讓玩家查看抽到的牌的時間（可用 DEALER_REVEAL_MS 覆寫）
export const DEALER_REVEAL_MS = Number(process.env.DEALER_REVEAL_MS ?? 3000);

export class GameEngine {
  players: EnginePlayer[];
  deck: Card[] = [];
  discardPile: Card[] = [];
  stage: Stage = 'DRAW';
  turnSeat = 0;
  pending: Pending | null = null;
  phase: RoomPhase = 'PLAYING';
  winnerSeat: number | null = null;
  winnerSelfDraw = false; // 本局是否為自摸胡牌（供前端在胡牌當下挑選對應音效）
  drawGame = false;
  message: string | null = null;
  roundResult: GameOverPayload | null = null; // 一局結束的結算（scores/nextDealerSeat 由 gameServer 補）

  // 吃牌窗狀態
  claimOrder: number[] = []; // 依優先順序（胡>吃、下家優先）排好的可宣告座位
  eatHolder: number | null = null; // 目前暫定吃到的人（EATING 時）
  tentative: Tentative | null = null; // 暫定對子資訊，供被搶時還原
  claimId = 0; // 每開一個新窗 +1，供伺服器排程對齊
  claimEndsAt = 0; // 下一家可摸牌的時間點（epoch ms）
  protectedSelfEat = false; // 自摸優先保護：摸牌者可胡自己的牌（最高優先），或可吃且無他家能胡 → 不限時、下家不能先摸
  tenpai: boolean[] = []; // 各座位是否聽牌（進入聽牌時宣告一次，§7）
  xianggong: boolean[] = []; // 相公：吃牌優先權最高卻逾時未吃 → 本局僅能觀看、不能做任何動作

  // 胡牌後手動抽五隻（§9.2）
  drawFive: DrawFiveState | null = null; // 進行中的抽五隻（DRAW_FIVE 階段）
  private pendingWin: PendingWin | null = null; // 抽五隻完成後據以組裝結算

  // 決定莊家（§4.1）互動抽牌狀態
  dealerSeat: number | null = null; // 已決定的莊家座位（DEAL_DRAW 進行中為 null）
  dealerDraws: (Card | null)[] = []; // 各座位此輪抽到的牌（null＝尚未抽）
  dealerContenders: number[] = []; // 仍在競爭莊家的座位（平手時只留平手者重抽）
  dealerDecided = false; // 已決定莊家、展示抽牌結果中（停留數秒後才發牌）
  dealerRevealEndsAt = 0; // 展示結束、正式發牌的時間點（epoch ms）

  private readonly n: number;
  private readonly rng: () => number;
  // 新手提示（建房選項）：開＝沒人能吃/胡就不開吃牌窗、legalActions 供前端鎖定按鈕；
  // 關＝每張牌都開吃牌窗，玩家自行判斷按吃/胡，按下後才由伺服器驗證
  readonly hints: boolean;
  readonly claimWindowMs: number; // 吃牌窗等待時間（建房時選擇）

  // dealerSeat=null：開局由玩家自己抽牌決定莊家（§4.1，僅第一局）；
  // 傳入座位號：直接指定莊家並發牌（續局／測試用）。
  constructor(
    seats: SeatInit[],
    dealerSeat: number | null,
    rng: () => number = Math.random,
    opts: EngineOptions = {},
  ) {
    this.n = seats.length;
    this.rng = rng;
    this.hints = opts.hints ?? true;
    this.claimWindowMs = opts.claimWindowMs ?? CLAIM_WINDOW_MS;
    this.tenpai = new Array(this.n).fill(false);
    this.xianggong = new Array(this.n).fill(false);
    this.players = seats.map((s, seat) => ({
      id: s.id,
      name: s.name,
      seat,
      hand: [],
      melds: [],
      deadIds: [],
      connected: true,
      isDealer: false,
      score: 0,
    }));
    if (dealerSeat === null) {
      this.startDealerDraw();
    } else {
      this.deal(dealerSeat, rng);
    }
  }

  // ── §4.1 抽牌決定莊家：每位玩家各自摸一張，先比權重再比顏色，平手者重抽 ──
  private startDealerDraw() {
    this.deck = shuffle(buildDeck(), this.rng); // 抽牌用牌堆（決定莊家後發牌會重洗）
    this.dealerDraws = new Array(this.n).fill(null);
    this.dealerContenders = this.players.map((p) => p.seat);
    this.stage = 'DEAL_DRAW';
    this.turnSeat = 0;
    this.message = '抽牌決定莊家：請每位玩家各摸一張牌';
  }

  // 某玩家抽出決定莊家的牌；等所有競爭者都抽完才比較
  private doDealerDraw(p: EnginePlayer): ApplyResult {
    const card = this.deck.shift()!;
    this.dealerDraws[p.seat] = card;
    this.message = `${p.name} 抽到 ${card.color}${card.rank}`;
    if (this.dealerContenders.some((s) => this.dealerDraws[s] == null)) {
      return { ok: true }; // 還有競爭者沒抽，繼續等
    }
    this.resolveDealerDraw();
    return { ok: true };
  }

  // 比較競爭者抽到的牌：唯一最大者當莊並發牌；平手者保留、重抽
  private resolveDealerDraw() {
    let best = -Infinity;
    for (const s of this.dealerContenders) best = Math.max(best, cardDrawStrength(this.dealerDraws[s]!));
    const tied = this.dealerContenders.filter((s) => cardDrawStrength(this.dealerDraws[s]!) === best);
    if (tied.length === 1) {
      const seat = tied[0];
      const dc = this.dealerDraws[seat]!;
      // 立即標記莊家，並停留展示 DEALER_REVEAL_MS 讓大家看清抽到的牌，時間到才發牌
      this.dealerSeat = seat;
      for (const p of this.players) p.isDealer = p.seat === seat;
      this.dealerContenders = [seat];
      this.dealerDecided = true;
      this.dealerRevealEndsAt = Date.now() + DEALER_REVEAL_MS;
      this.message = `${this.players[seat].name} 抽到 ${dc.color}${dc.rank}，當莊！`;
      return;
    }
    // 平手：只保留平手者重抽，已淘汰者不必重抽（§4.1）
    this.dealerContenders = tied;
    for (const s of tied) this.dealerDraws[s] = null;
    this.message = `平手（${tied.map((s) => this.players[s].name).join('、')}）→ 平手者重抽`;
  }

  // 展示時間結束 → 正式發牌開局（由 gameServer 於 dealerRevealEndsAt 後呼叫）
  finalizeDealerDraw(): void {
    if (this.stage !== 'DEAL_DRAW' || !this.dealerDecided || this.dealerSeat === null) return;
    this.dealerDecided = false;
    this.dealerRevealEndsAt = 0;
    this.deal(this.dealerSeat, this.rng); // 重洗牌發牌（莊 10、其餘 9）；天胡則直接結算
    if (this.phase !== 'FINISHED') {
      this.message = `${this.players[this.dealerSeat].name} 當莊，開局（莊家先打）`;
    }
  }

  // ── 發牌（§5）：莊家 10 張，其餘 9 張 ──────────────────
  private deal(dealerSeat: number, rng: () => number) {
    this.dealerSeat = dealerSeat;
    for (const p of this.players) p.isDealer = p.seat === dealerSeat;
    this.deck = shuffle(buildDeck(), rng);
    for (const p of this.players) {
      const count = p.seat === dealerSeat ? 10 : 9;
      p.hand = this.deck.splice(0, count);
      this.sortHand(p);
    }
    this.turnSeat = dealerSeat;
    if (isWinningSet(this.ownedCards(this.players[dealerSeat]))) {
      this.win(dealerSeat, '天胡', {}); // 開手即胡，無胡牌張，全體付
    } else {
      this.stage = 'DISCARD'; // 莊家先打一張（不摸牌）
      this.message = `${this.players[dealerSeat].name} 開局（莊家先打）`;
      this.refreshTenpai();
    }
  }

  private sortHand(p: EnginePlayer) {
    p.hand.sort((a, b) => a.id.localeCompare(b.id));
  }

  private ownedCards(p: EnginePlayer): Card[] {
    return [...p.hand, ...p.melds.flat()];
  }

  // 逆時鐘換人（§6）：下一位＝座位號 -1
  private nextSeat(seat: number): number {
    return (seat + this.n - 1) % this.n;
  }

  // 下一位「可行動」的座位：跳過相公（相公本局不摸牌、不出牌）
  private nextActiveSeat(seat: number): number {
    let s = this.nextSeat(seat);
    for (let i = 0; i < this.n && this.xianggong[s]; i++) s = this.nextSeat(s);
    return s;
  }

  // 依逆時鐘輪替方向計算 fromSeat 到 seat 的距離（1＝下家；下家優先用，§7.2）
  private turnDistance(fromSeat: number, seat: number, includeSelf: boolean): number {
    if (seat === fromSeat) return includeSelf ? 0 : Infinity;
    return (fromSeat - seat + this.n) % this.n;
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
      if (this.xianggong[p.seat]) continue; // 相公本局不能吃/胡
      if (isWinningSet([...this.ownedCards(p), card])) winners.push(p.seat);
      else if (hasMatch(p.hand, card)) eaters.push(p.seat);
    }
    const byDistance = (a: number, b: number) =>
      this.turnDistance(fromSeat, a, includeOfferer) -
      this.turnDistance(fromSeat, b, includeOfferer);
    winners.sort(byDistance);
    eaters.sort(byDistance);
    this.claimOrder = [...winners, ...eaters];
    this.eatHolder = null;
    this.tentative = null;
    this.protectedSelfEat = false;

    // 新手提示開：沒人能吃/胡就不開窗，直接落桌、換人（提示效果：窗開著＝有人能吃）。
    // 提示關：每張牌都照常開限時窗，玩家自行判斷按吃/胡（按下後由伺服器驗證）。
    if (this.hints && this.claimOrder.length === 0) {
      this.resolveNoClaim();
      return;
    }
    this.stage = 'CLAIM';
    this.claimId++;

    // 自摸最高優先：多家聽同一張時，摸牌者能「胡」自己摸的牌 → 由摸牌者先決定（不限時），
    // 他家（即使也聽這張）都要等摸牌者胡／吃／不吃後才有機會。
    // 自摸吃保護：摸牌者只能「吃」自己摸的牌時，仍需沒有其他家能胡才保護（胡 > 吃）。
    const drawerCanWin = winners.includes(fromSeat);
    const drawerCanClaim = drawerCanWin || eaters.includes(fromSeat);
    const otherHu = winners.some((s) => s !== fromSeat);
    if (kind === 'drawn' && drawerCanClaim && (drawerCanWin || !otherHu)) {
      this.protectedSelfEat = true;
      this.claimEndsAt = Number.MAX_SAFE_INTEGER; // 不限時
      return;
    }
    this.claimEndsAt = Date.now() + this.claimWindowMs;
  }

  private formTentativeEat(seat: number) {
    const card = this.pending!.card;
    const p = this.players[seat];
    // 優先用死牌配對（讓死牌就地成對、解除死牌狀態，§7.2）
    let matchIdx = p.hand.findIndex((c) => isPair(c, card) && p.deadIds.includes(c.id));
    if (matchIdx < 0) matchIdx = p.hand.findIndex((c) => isPair(c, card));
    const [match] = p.hand.splice(matchIdx, 1);
    const dIdx = p.deadIds.indexOf(match.id);
    const matchWasDead = dIdx >= 0;
    if (matchWasDead) p.deadIds.splice(dIdx, 1);
    p.melds.push([match, card]); // 暫定公開對子
    this.tentative = { seat, meldIndex: p.melds.length - 1, match, matchWasDead };
    this.eatHolder = seat;
    this.protectedSelfEat = false;
    this.turnSeat = seat; // 由吃牌者打一張（§7.3）
    this.stage = 'EATING';
    this.message = `${p.name} 吃 ${card.color}${card.rank}`;
  }

  private undoTentativeEat() {
    if (!this.tentative) return;
    const { seat, meldIndex, match, matchWasDead } = this.tentative;
    const p = this.players[seat];
    p.melds.splice(meldIndex, 1); // 暫定對子一定是最後一個
    p.hand.push(match);
    if (matchWasDead) p.deadIds.unshift(match.id); // 還原死牌狀態（放回 FIFO 前端）
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
    if (this.xianggong[seat]) return []; // 相公：本局僅能觀看，不能做任何動作
    if (this.stage === 'DRAW_FIVE') {
      // 只有胡牌者能抽，抽到 5 張或牌堆抽完為止（§9.2）
      if (!this.drawFive || seat !== this.drawFive.winnerSeat) return [];
      return this.drawFive.entries.length < 5 && this.deck.length > 0 ? ['drawFive'] : [];
    }
    if (this.stage === 'DEAL_DRAW') {
      if (this.dealerDecided) return []; // 已決定莊家、展示中，任何人都不能再抽
      // 決定莊家：仍在競爭且此輪尚未抽的玩家可以抽
      return this.dealerContenders.includes(seat) && this.dealerDraws[seat] == null ? ['draw'] : [];
    }
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
      // 下一位「可行動」者才可摸牌關窗：跳過相公，否則相公卡在下家位置時無人能摸牌、遊戲卡死
      seat === this.nextActiveSeat(this.pending.fromSeat) &&
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
    let res: ApplyResult;
    switch (action) {
      case 'draw':
        res = this.doDraw(p);
        break;
      case 'discard':
        res = this.doDiscard(p, cardId);
        break;
      case 'eat':
        res = this.doEatClaim(p.seat);
        break;
      case 'declareWin':
        res = this.doDeclareWin(p);
        break;
      case 'pass':
        res = this.doPass(p);
        break;
      case 'drawFive':
        res = this.doDrawFive(p);
        break;
      default:
        return { ok: false, error: '未知動作' };
    }
    // 本局未結束、且非抽五隻階段才更新聽牌（抽五隻不影響任何人手牌）
    if (res.ok && !this.roundResult && this.stage !== 'DRAW_FIVE') this.refreshTenpai();
    return res;
  }

  private doDraw(p: EnginePlayer): ApplyResult {
    if (this.stage === 'DEAL_DRAW') return this.doDealerDraw(p); // 決定莊家的抽牌（§4.1）
    // 下一家在兩秒後摸牌 → 關閉吃牌窗（沒按吃者當過牌），原牌落桌
    if (this.stage === 'CLAIM') {
      this.markClaimTimeout(p.seat); // 優先權最高卻逾時未吃者 → 相公
      this.clearClaim();
      this.resolveNoClaim();
      if (String(this.stage) !== 'DRAW' || this.turnSeat !== p.seat) return { ok: true };
    }
    if (this.deck.length <= DRAW_GAME_FLOOR) {
      this.drawGame = true;
      this.phase = 'FINISHED';
      this.winnerSeat = null;
      this.message = '流局（牌堆剩九張，原莊連任）';
      this.roundResult = this.buildDrawResult();
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
    // 死牌強制出牌（§7.3）：有死牌時必須打出死牌（先進先出，兩張且可聽牌時例外）
    const forced = this.forcedDiscardIds(p);
    if (forced && (!cardId || !forced.includes(cardId))) {
      // 明確點名「哪一張」才符合先進先出，避免玩家誤以為死牌可任選一張打出
      const names = forced
        .map((id) => p.hand.find((c) => c.id === id))
        .filter((c): c is Card => !!c)
        .map((c) => `${c.color}${c.rank}`)
        .join('、');
      return {
        ok: false,
        error:
          forced.length > 1
            ? `手上有死牌，需先打出其中一張：${names}`
            : `手上有死牌，需先打出「${names}」（死牌先進先出）`,
      };
    }
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return { ok: false, error: '手牌中沒有這張牌' };
    // 死牌形成（§7.2）：提交吃牌時，其他「能吃卻沒吃到」的玩家，其配對牌變死牌並公開
    if (this.stage === 'EATING' && this.pending) {
      this.formDeadCards(p.seat, this.pending.card, this.pending.fromSeat);
    }
    const [card] = p.hand.splice(idx, 1);
    const di = p.deadIds.indexOf(card.id);
    if (di >= 0) p.deadIds.splice(di, 1); // 打出的是死牌 → 移出死牌佇列
    // 提交暫定吃牌（對子成為正式），清掉暫定狀態
    this.tentative = null;
    this.eatHolder = null;
    this.pending = { card, fromSeat: p.seat, kind: 'discard' };
    this.message = `${p.name} 打出 ${card.color}${card.rank}`;
    this.startClaim(false); // 打出的牌只有其他玩家能吃/胡（放槍）
    return { ok: true };
  }

  // 出牌時允許打出的牌 id 清單（§7.3）；null = 無限制（可打任何手牌）
  private forcedDiscardIds(p: EnginePlayer): string[] | null {
    if (p.deadIds.length === 0) return null;
    const allowed = new Set<string>([p.deadIds[0]]); // 先進先出：預設只能出最舊的死牌
    // 例外：剛好兩張死牌，若改出另一張後進入聽牌 → 可自選（不用先進先出）
    if (p.deadIds.length === 2) {
      const other = p.deadIds[1];
      const remaining = p.hand.filter((c) => c.id !== other);
      if (isTenpai([...remaining, ...p.melds.flat()])) allowed.add(other);
    }
    return [...allowed];
  }

  // 提交吃牌時，替其他「能吃卻沒吃到」的玩家標記死牌（§7.2）
  private formDeadCards(eaterSeat: number, eaten: Card, fromSeat: number) {
    for (const other of this.players) {
      if (other.seat === eaterSeat || other.seat === fromSeat) continue;
      if (!hasMatch(other.hand, eaten)) continue; // 手上沒有可吃的配對就不成死牌
      const idx = other.hand.findIndex(
        (c) => isPair(c, eaten) && !other.deadIds.includes(c.id),
      );
      if (idx < 0) continue;
      other.deadIds.push(other.hand[idx].id);
      this.message =
        (this.message ? this.message + '｜' : '') +
        `${other.name} 的 ${eaten.color}${eaten.rank} 成死牌`;
    }
  }

  // 重算各家聽牌狀態；新聽牌者宣告一次（§7）
  private refreshTenpai() {
    for (const p of this.players) {
      const now = isTenpai(this.ownedCards(p));
      if (now && !this.tenpai[p.seat]) {
        this.message = (this.message ? this.message + '｜' : '') + `${p.name} 聽牌！`;
      }
      this.tenpai[p.seat] = now;
    }
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
      const kind = this.pending.kind;
      const fromSeat = this.pending.fromSeat;
      const handBefore = [...p.hand]; // 加入胡牌張前的暗手牌（胡開判定用）
      p.hand.push(card);
      this.sortHand(p);
      this.pending = null;
      this.clearClaim();
      if (kind === 'drawn') {
        // 自摸或別人摸牌被胡：全體付、可抽五隻（§9.2/§11）；自摸另加一頭
        const selfDraw = p.seat === fromSeat;
        this.win(p.seat, selfDraw ? '自摸' : '胡（摸牌）', {
          winningCard: card,
          loserSeat: null,
          handBefore,
          selfDraw,
        });
      } else {
        // 放槍：只有打牌者付、不能抽五隻
        this.win(p.seat, '胡（放槍）', { winningCard: card, loserSeat: fromSeat, handBefore });
      }
      return { ok: true };
    }
    if (this.stage === 'DISCARD' && isWinningSet(this.ownedCards(p))) {
      this.win(p.seat, '胡', {}); // 開手胡，無胡牌張，全體付
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
      // 還有他家能吃這張摸出的牌 → 轉為限時窗，等待時間到後下家可摸牌
      this.stage = 'CLAIM';
      this.claimId++;
      this.claimEndsAt = Date.now() + this.claimWindowMs;
      return { ok: true };
    }
    this.clearClaim();
    this.resolveNoClaim(); // 沒人要 → 摸到的牌落桌、換下一位
    return { ok: true };
  }

  // 無人宣告 → 待宣告的牌進棄牌區（落在桌面），逆時鐘換下一位摸牌（§6.5/§6.6）
  private resolveNoClaim() {
    if (this.pending) {
      this.discardPile.push(this.pending.card);
      const from = this.pending.fromSeat;
      this.pending = null;
      this.turnSeat = this.nextActiveSeat(from); // 跳過相公
    }
    this.stage = 'DRAW';
  }

  // 吃牌窗逾時被下一家摸牌關閉：優先權最高卻沒宣告的玩家成為相公
  // （下一家自己就是最高優先者時不算——他是主動選擇摸牌放棄，非逾時）
  private markClaimTimeout(closerSeat: number) {
    const top = this.claimOrder[0];
    if (top === undefined || top === closerSeat) return;
    this.xianggong[top] = true;
    this.message =
      (this.message ? this.message + '｜' : '') +
      `${this.players[top].name} 逾時未吃，本局相公（僅能觀看）`;
  }

  private win(seat: number, label: string, ctx: WinContext = {}) {
    this.winnerSeat = seat;
    this.winnerSelfDraw = !!ctx.selfDraw;
    this.pending = null;
    this.clearClaim();
    const winner = this.players[seat];
    const winningCard = ctx.winningCard ?? null;
    const loserSeat = ctx.loserSeat ?? null;
    const handBefore = ctx.handBefore ?? winner.hand;
    const color = colorScore(this.ownedCards(winner)); // §11 顏色

    // 四色（0 頭）：直接以 0 頭結算，不加胡開/自摸頭、也不抽五隻（§11）
    if (color === 0) {
      this.finishWith(this.assembleResult(seat, label, 0, 0, 0, [], loserSeat, false, winningCard));
      this.message = `${winner.name} ${label}胡牌！（四色 0 頭）`;
      return;
    }
    const huKai = huKaiBonus(handBefore, winner.melds, winningCard); // §10.1 胡開
    const selfDraw = ctx.selfDraw ? 1 : 0; // 自摸加一頭

    // 抽五隻資格：自摸／摸牌胡（無放槍者）且有胡牌張；放槍不能抽（§9.2）
    const eligible = loserSeat === null && winningCard !== null;
    if (eligible && this.deck.length > 0) {
      // 進入手動抽五隻：由胡牌者一張一張抽，抽完才結算（不先設 FINISHED）
      this.stage = 'DRAW_FIVE';
      this.turnSeat = seat;
      this.pendingWin = { seat, label, color, huKai, selfDraw, loserSeat, winningCard };
      this.drawFive = {
        winnerSeat: seat,
        winningCard,
        // 加頭條件：抽中胡牌者牌組（五對）中任一種（同花同牌，§9.2）
        kinds: new Set(this.ownedCards(winner).map(kindKey)),
        entries: [],
      };
      this.message = `${winner.name} ${label}胡牌！請抽五隻`;
      return;
    }
    // 放槍／天胡／牌堆已空：無抽五隻，直接結算
    const showDrawFive = eligible; // 有資格但牌堆已空 → 仍揭示（空的）抽五隻
    this.finishWith(
      this.assembleResult(seat, label, color, huKai, selfDraw, [], loserSeat, showDrawFive, winningCard),
    );
    this.message = `${winner.name} ${label}胡牌！`;
  }

  // 胡牌者手動抽一張抽五隻的牌（§9.2）；抽滿 5 張或牌堆抽完即結算
  private doDrawFive(p: EnginePlayer): ApplyResult {
    if (this.stage !== 'DRAW_FIVE' || !this.drawFive || p.seat !== this.drawFive.winnerSeat) {
      return { ok: false, error: '現在無法抽五隻' };
    }
    if (this.deck.length === 0) return { ok: false, error: '牌堆已無牌可抽' };
    const card = this.deck.shift()!;
    const qualifying = this.drawFive.kinds.has(kindKey(card)); // 符合牌組任一種即加頭
    const index = this.drawFive.entries.length; // 0..4
    const heads = qualifying ? (index === 4 ? 2 : 1) : 0; // 第五張（最後一張）符合加兩頭
    this.drawFive.entries.push({ card, qualifying, heads });
    this.message = `抽到 ${card.color}${card.rank}${qualifying ? '（加頭！）' : ''}`;
    if (this.drawFive.entries.length >= 5 || this.deck.length === 0) {
      this.finalizeDrawFive();
    }
    return { ok: true };
  }

  // 抽五隻結束：彙整加頭並組裝最終結算
  private finalizeDrawFive() {
    const pw = this.pendingWin!;
    const entries = this.drawFive!.entries;
    this.finishWith(
      this.assembleResult(
        pw.seat, pw.label, pw.color, pw.huKai, pw.selfDraw, entries, pw.loserSeat, true, pw.winningCard,
      ),
    );
    this.message = `${this.players[pw.seat].name} ${pw.label}胡牌！`;
  }

  // 設定本局為結束並記錄結算
  private finishWith(result: GameOverPayload) {
    this.phase = 'FINISHED';
    this.stage = 'DISCARD';
    this.pending = null;
    this.drawFive = null;
    this.pendingWin = null;
    this.clearClaim();
    this.roundResult = result;
  }

  // 計分（§11 顏色 + §10.1 胡開 + 自摸加頭 + §9.2 抽五隻）與付款分配
  private assembleResult(
    seat: number,
    label: string,
    color: number,
    huKai: number,
    selfDraw: number,
    entries: { card: Card; qualifying: boolean; heads: number }[],
    loserSeat: number | null,
    showDrawFive: boolean,
    winningCard: Card | null,
  ): GameOverPayload {
    const winner = this.players[seat];
    const dfHeads = entries.reduce((s, e) => s + e.heads, 0);
    const heads = color + huKai + selfDraw + dfHeads;
    // 胡牌者的完整牌組（五對）：依牌種排序讓成對的牌相鄰，供結算畫面展示
    const winnerHand = [...this.ownedCards(winner)].sort((a, b) =>
      kindKey(a) === kindKey(b) ? a.id.localeCompare(b.id) : kindKey(a).localeCompare(kindKey(b)),
    );

    // 付款：放槍只有放槍者付；自摸／摸牌胡則其餘全體各付一份（§11 勝負計算）
    const payers =
      loserSeat !== null
        ? [loserSeat]
        : this.players.filter((p) => p.seat !== seat).map((p) => p.seat);
    const payments = this.players.map((p) => ({
      seat: p.seat,
      delta: p.seat === seat ? heads * payers.length : payers.includes(p.seat) ? -heads : 0,
    }));

    return {
      winnerSeat: seat,
      winnerName: winner.name,
      reason: 'win',
      category: label,
      heads,
      breakdown: { color, huKai, selfDraw, drawFive: dfHeads },
      drawFive: showDrawFive
        ? {
            cards: entries.map((e) => e.card),
            qualifying: entries.filter((e) => e.qualifying).length,
            marks: entries.map((e) => e.qualifying),
          }
        : null,
      winnerHand,
      winningCard,
      payments,
      scores: [], // gameServer 補跨局累計
      nextDealerSeat: seat, // 胡牌者下一局當莊（§4.2）
    };
  }

  private buildDrawResult(): GameOverPayload {
    return {
      winnerSeat: null,
      winnerName: null,
      reason: 'draw',
      category: '流局',
      heads: 0,
      breakdown: { color: 0, huKai: 0, selfDraw: 0, drawFive: 0 },
      drawFive: null,
      winnerHand: null,
      winningCard: null,
      payments: this.players.map((p) => ({ seat: p.seat, delta: 0 })),
      scores: [],
      nextDealerSeat: null, // gameServer：原莊連任（§4.2）
    };
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
      handCount: p.hand.length - p.deadIds.length, // 死牌另外公開，不算暗牌
      melds: p.melds,
      deadCards: p.deadIds
        .map((id) => p.hand.find((c) => c.id === id))
        .filter((c): c is Card => !!c),
      connected: p.connected,
      isDealer: p.isDealer,
      isTenpai: this.tenpai[p.seat],
      isXianggong: this.xianggong[p.seat],
      score: p.score,
    }));
    const lastDrawn =
      this.pending && this.pending.kind === 'drawn' && this.stage === 'CLAIM'
        ? { seat: this.pending.fromSeat, card: this.pending.card }
        : null;
    const pendingClaim =
      this.stage === 'CLAIM' && this.pending
        ? { card: this.pending.card, fromSeat: this.pending.fromSeat }
        : null;
    // 有人暫定吃牌：公開「誰吃了哪張」讓所有玩家看到（待吃牌者打出才定案）
    const eating =
      this.stage === 'EATING' && this.eatHolder !== null && this.pending
        ? {
            seat: this.eatHolder,
            card: this.pending.card,
            matchedDeadCard: this.tentative?.matchWasDead ?? false,
          }
        : null;
    // 胡牌後手動抽五隻（§9.2）：把已抽出的牌（含加頭標記）公開給前端顯示
    const drawFive: DrawFiveView | null =
      this.stage === 'DRAW_FIVE' && this.drawFive
        ? {
            winnerSeat: this.drawFive.winnerSeat,
            winnerName: this.players[this.drawFive.winnerSeat].name,
            winningCard: this.drawFive.winningCard,
            entries: this.drawFive.entries.map((e) => ({ ...e })),
            drawn: this.drawFive.entries.length,
            total: Math.min(5, this.drawFive.entries.length + this.deck.length),
            canDraw:
              me.seat === this.drawFive.winnerSeat &&
              this.deck.length > 0 &&
              this.drawFive.entries.length < 5,
          }
        : null;
    // 決定莊家（§4.1）：把各座位抽到的牌與競爭者公開給前端顯示
    const dealerDraw =
      this.stage === 'DEAL_DRAW'
        ? {
            draws: this.players.map((p) => this.dealerDraws[p.seat] ?? null),
            contenders: [...this.dealerContenders],
            decidedSeat: this.dealerDecided ? this.dealerSeat : null, // 已定莊 → 展示中
          }
        : null;
    return {
      roomId: '',
      phase: this.phase,
      players: publicPlayers,
      you: {
        id: me.id,
        seat: me.seat,
        hand: me.hand,
        melds: me.melds,
        deadIds: me.deadIds,
        forcedDiscardIds: this.forcedDiscardIds(me),
      },
      deckCount: this.deck.length,
      discardPile: this.discardPile,
      currentTurnSeat: this.turnSeat,
      lastDrawn,
      pendingClaim,
      eating,
      dealerDraw,
      // 自摸保護時不限時 → 不送倒數（前端不顯示倒數條）
      claimEndsAt: this.stage === 'CLAIM' && !this.protectedSelfEat ? this.claimEndsAt : null,
      claimWindowMs: this.claimWindowMs,
      drawFive,
      continueReady: [], // 由 gameServer/index 依房間 readyIds 補上
      paused: false, // 由 index 依房間 paused 補上（引擎不知房間層斷線狀態）
      disconnectedNames: [], // 由 index 依房間斷線玩家補上
      legalActions: this.legalActionsFor(me.seat),
      hints: this.hints,
      winnerSeat: this.winnerSeat,
      winnerSelfDraw: this.winnerSelfDraw,
      message: this.message,
    };
  }
}
