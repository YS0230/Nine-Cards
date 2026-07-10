// 五人以上（最多八人）的多人局：發牌、逆時鐘輪替、吃牌窗優先順序、結算付家、房間人數上限
import { describe, it, expect } from 'vitest';
import type { Card } from '@nine-cards/shared';
import { GameEngine } from '../src/game/engine.js';
import { GameServer } from '../src/game/gameServer.js';

const c = (color: Card['color'], rank: Card['rank'], copy = 1): Card => ({
  id: `${color}_${rank}_${copy}`,
  color,
  rank,
});

const seatsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), name: `P${i}` }));

// 湊 9 張暗牌：一張 黃帥 + 四對，配上一張黃帥即成五對胡牌
const winningNine = () => [
  c('黃', '帥', 2),
  c('紅', '仕'), c('紅', '仕', 2),
  c('綠', '將'), c('綠', '將', 2),
  c('白', '卒'), c('白', '卒', 2),
  c('黃', '兵'), c('黃', '兵', 2),
];

// 與黃帥無關、湊不成五對的雜牌手（避免隨機發牌讓其他座位意外能吃/胡）
const neutralHand = (seat: number) => [c('白', '車', seat * 3 + 1), c('白', '馬', seat * 3 + 2), c('綠', '象', seat * 3 + 3)];

describe('多人發牌（§5）', () => {
  it('六人：莊 10 張、其餘各 9 張、牌堆 = 112 - 55', () => {
    const eng = new GameEngine(seatsOf(6), 0);
    expect(eng.players[0].hand).toHaveLength(10);
    for (let s = 1; s < 6; s++) expect(eng.players[s].hand).toHaveLength(9);
    expect(eng.deck.length).toBe(112 - (10 + 9 * 5));
  });
  it('八人：發 73 張後牌堆仍高於流局底線 9 張', () => {
    const eng = new GameEngine(seatsOf(8), 0);
    const dealt = eng.players.reduce((s, p) => s + p.hand.length, 0);
    expect(dealt).toBe(10 + 9 * 7);
    expect(eng.deck.length).toBe(112 - dealt);
    expect(eng.deck.length).toBeGreaterThan(9);
  });
});

describe('六人逆時鐘輪替（§6）', () => {
  it('摸出的牌無人可吃 → 落桌，輪到座位號 -1 的下家', () => {
    const eng = new GameEngine(seatsOf(6), 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DRAW';
    eng.turnSeat = 0;
    for (let s = 0; s < 6; s++) eng.players[s].hand = neutralHand(s);
    eng.deck = [c('紅', '炮', 1), ...Array.from({ length: 12 }, (_, i) => c('紅', '兵', i + 1))];
    eng.discardPile = [];
    const r = eng.apply('0', 'draw');
    expect(r.ok).toBe(true);
    expect(eng.discardPile.map((x) => x.id)).toContain('紅_炮_1');
    expect(eng.stage).toBe('DRAW');
    expect(eng.turnSeat).toBe(5); // 逆時鐘：seat0 的下家＝seat5
  });
});

// 六人局：seat0 打出黃帥；seat4 聽這張可胡，seat5（下家）與 seat3 都可吃
function sixPlayerClaimSetup() {
  const eng = new GameEngine(seatsOf(6), 0);
  eng.phase = 'PLAYING';
  eng.stage = 'DISCARD';
  eng.turnSeat = 0;
  for (let s = 0; s < 6; s++) eng.players[s].hand = neutralHand(s);
  eng.players[0].hand = [c('黃', '帥', 9), c('綠', '士')];
  eng.players[3].hand = [c('黃', '帥', 3), c('綠', '將', 8)];
  eng.players[4].hand = winningNine();
  eng.players[5].hand = [c('黃', '帥', 4), c('白', '卒', 8)];
  eng.deck = Array.from({ length: 20 }, (_, i) => c('紅', '兵', i + 1));
  eng.discardPile = [];
  const r = eng.apply('0', 'discard', '黃_帥_9');
  expect(r.ok).toBe(true);
  return eng;
}

describe('六人吃牌窗優先順序（§7.2 胡 > 吃、下家優先）', () => {
  it('claimOrder＝[可胡者, 下家, 更遠的可吃者]', () => {
    const eng = sixPlayerClaimSetup();
    expect(eng.stage).toBe('CLAIM');
    // 距離：seat5=1（下家）、seat4=2、seat3=3；胡（seat4）排最前
    expect(eng.claimOrder).toEqual([4, 5, 3]);
  });

  it('遠家先吃 → 下家可搶 → 聽牌者胡最大（撤銷暫定吃）', () => {
    const eng = sixPlayerClaimSetup();
    expect(eng.apply('3', 'eat').ok).toBe(true); // 最低優先先按
    expect(eng.eatHolder).toBe(3);
    expect(eng.apply('5', 'eat').ok).toBe(true); // 下家優先，搶走
    expect(eng.eatHolder).toBe(5);
    expect(eng.players[3].melds).toHaveLength(0); // 讓出、對子還原
    const win = eng.apply('4', 'declareWin'); // 胡 > 吃
    expect(win.ok).toBe(true);
    expect(eng.winnerSeat).toBe(4);
    expect(eng.players[5].melds).toHaveLength(0); // 暫定吃被撤銷
  });

  it('低優先者不能反搶下家', () => {
    const eng = sixPlayerClaimSetup();
    expect(eng.apply('5', 'eat').ok).toBe(true);
    expect(eng.apply('3', 'eat').ok).toBe(false); // 優先權不足
    expect(eng.eatHolder).toBe(5);
  });
});

describe('六人結算（§11 自摸全家付）', () => {
  it('自摸胡牌 → 其餘五家各付 heads、贏家收 heads×5、總和為零', () => {
    const eng = new GameEngine(seatsOf(6), 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DRAW';
    eng.turnSeat = 1;
    for (let s = 0; s < 6; s++) eng.players[s].hand = neutralHand(s);
    eng.players[1].hand = winningNine(); // 聽黃帥
    eng.deck = [c('黃', '帥', 9), ...Array.from({ length: 20 }, (_, i) => c('紅', '兵', i + 1))];
    eng.discardPile = [];
    expect(eng.apply('1', 'draw').ok).toBe(true);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    // 自摸胡牌 → 進入抽五隻（§9.2），抽完才結算
    while (eng.legalActionsFor(1).includes('drawFive')) {
      expect(eng.apply('1', 'drawFive').ok).toBe(true);
    }
    const rr = eng.roundResult!;
    expect(rr).toBeTruthy();
    expect(rr.payments).toHaveLength(6);
    const winner = rr.payments.find((p) => p.seat === 1)!;
    const payers = rr.payments.filter((p) => p.seat !== 1);
    expect(payers.every((p) => p.delta === -rr.heads)).toBe(true); // 未胡牌者都需支付
    expect(winner.delta).toBe(rr.heads * 5);
    expect(rr.payments.reduce((s, p) => s + p.delta, 0)).toBe(0);
  });
});

describe('房間人數上限（建房選項 2–8）', () => {
  it('六人房：第六位可加入、第七位被拒', () => {
    const gs = new GameServer();
    const host = gs.createRoom('房主', 'sock0', false, true, undefined, undefined, undefined, 6);
    expect(host.ok).toBe(true);
    const code = host.room!.code;
    for (let i = 1; i < 6; i++) {
      expect(gs.joinByCode(code, `P${i}`, `sock${i}`).ok).toBe(true);
    }
    const seventh = gs.joinByCode(code, 'P6', 'sock6');
    expect(seventh.ok).toBe(false);
    expect(seventh.error).toBe('房間已滿');
    const view = gs.roomView(host.room!);
    expect(view.maxPlayers).toBe(6);
    expect(view.seats).toHaveLength(6);
  });

  it('六人到齊可開局，引擎座位數為 6', () => {
    const gs = new GameServer();
    const host = gs.createRoom('房主', 'sock0', false, true, undefined, undefined, undefined, 6);
    const code = host.room!.code;
    for (let i = 1; i < 6; i++) gs.joinByCode(code, `P${i}`, `sock${i}`);
    const r = gs.startGame(host.player!.id);
    expect(r.ok).toBe(true);
    expect(host.room!.engine!.players).toHaveLength(6);
  });

  it('非法人數回落預設 4（超過 8、少於 2、非數字）', () => {
    const gs = new GameServer();
    for (const bad of [99, 1, 0, Number.NaN]) {
      const r = gs.createRoom('房主', `sock-${bad}`, false, true, undefined, undefined, undefined, bad);
      expect(r.room!.maxPlayers).toBe(4);
    }
    const eight = gs.createRoom('房主', 'sock8', false, true, undefined, undefined, undefined, 8);
    expect(eight.room!.maxPlayers).toBe(8);
  });
});
