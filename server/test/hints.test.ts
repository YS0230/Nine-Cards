import { describe, it, expect } from 'vitest';
import { buildDeck, type Card } from '@nine-cards/shared';
import { GameEngine } from '../src/game/engine.js';

const c = (color: Card['color'], rank: Card['rank'], copy = 1): Card => ({
  id: `${color}_${rank}_${copy}`,
  color,
  rank,
});

const seats3 = [
  { id: '0', name: 'P0' },
  { id: '1', name: 'P1' },
  { id: '2', name: 'P2' },
];

// 佈置：seat0（莊家）打出 黃帥1，其餘兩家都不能吃/胡
function setupNoClaimDiscard(hints: boolean, claimWindowMs?: number) {
  const eng = new GameEngine(seats3, 0, () => 0.5, { hints, claimWindowMs });
  eng.phase = 'PLAYING';
  eng.stage = 'DISCARD';
  eng.turnSeat = 0;
  eng.players[0].hand = [
    c('黃', '帥', 1),
    c('黃', '仕', 1), c('紅', '仕', 1), c('綠', '將', 1), c('白', '卒', 1),
    c('紅', '炮', 1), c('綠', '馬', 1), c('白', '包', 1), c('黃', '兵', 1), c('紅', '傌', 1),
  ];
  // 其他兩家：沒有黃帥（不能吃）、全單張（配上黃帥也不成五對，不能胡）
  eng.players[1].hand = [
    c('黃', '仕', 2), c('紅', '仕', 2), c('綠', '將', 2), c('白', '卒', 2),
    c('紅', '炮', 2), c('綠', '馬', 2), c('白', '包', 2), c('黃', '兵', 2), c('紅', '傌', 2),
  ];
  eng.players[2].hand = [
    c('黃', '相', 1), c('紅', '相', 1), c('綠', '象', 1), c('白', '象', 1),
    c('紅', '車', 1), c('綠', '車', 1), c('白', '馬', 1), c('黃', '炮', 1), c('紅', '卒', 1),
  ];
  for (const p of eng.players) {
    p.melds = [];
    p.deadIds = [];
  }
  // 牌堆用第 3/4 份複本，避免與上面手牌 id 重複
  eng.deck = buildDeck().filter((x) => x.id.endsWith('_3') || x.id.endsWith('_4'));
  return eng;
}

describe('新手提示（建房選項）', () => {
  it('提示開（預設）：沒人能吃 → 不開吃牌窗，直接落桌換人', () => {
    const eng = setupNoClaimDiscard(true);
    expect(eng.apply('0', 'discard', '黃_帥_1').ok).toBe(true);
    expect(eng.stage).toBe('DRAW'); // 沒開窗
    expect(eng.discardPile.map((x) => x.id)).toContain('黃_帥_1');
    expect(eng.turnSeat).toBe(2); // 逆時鐘：seat0 的下家＝seat2
  });

  it('提示關：沒人能吃也開限時窗，按吃由伺服器判定駁回', () => {
    const eng = setupNoClaimDiscard(false);
    expect(eng.apply('0', 'discard', '黃_帥_1').ok).toBe(true);
    // 仍開吃牌窗（不因沒人能吃而跳過）
    expect(eng.stage).toBe('CLAIM');
    expect(eng.claimOrder).toEqual([]);
    // 不能吃的玩家按「吃」→ 伺服器駁回
    const eat = eng.apply('1', 'eat');
    expect(eat.ok).toBe(false);
    expect(eat.error).toBe('現在無法執行此動作');
    // 亂按「胡」也駁回
    expect(eng.apply('2', 'declareWin').ok).toBe(false);
    // 時間到後下家（逆時鐘＝seat2）摸牌關窗 → 原牌落桌
    eng.claimEndsAt = 0;
    expect(eng.apply('2', 'draw').ok).toBe(true);
    expect(eng.discardPile.map((x) => x.id)).toContain('黃_帥_1');
    // 沒人被判相公（claimOrder 為空，無逾時未吃者）
    expect(eng.xianggong.every((x) => !x)).toBe(true);
  });

  it('提示關：viewFor 帶出 hints=false 供前端解鎖按鈕', () => {
    const eng = setupNoClaimDiscard(false);
    expect(eng.viewFor('1').hints).toBe(false);
    expect(setupNoClaimDiscard(true).viewFor('1').hints).toBe(true);
  });

  it('提示關＋下家相公：摸牌權跳過相公給再下一家，遊戲不卡死', () => {
    const eng = setupNoClaimDiscard(false);
    eng.xianggong[2] = true; // 下家（逆時鐘＝seat2）已相公
    expect(eng.apply('0', 'discard', '黃_帥_1').ok).toBe(true);
    expect(eng.stage).toBe('CLAIM');
    eng.claimEndsAt = 0; // 時間到
    // 相公本人不能有任何動作；摸牌權跳過他、落在 seat1
    expect(eng.legalActionsFor(2)).toEqual([]);
    expect(eng.legalActionsFor(1)).toContain('draw');
    expect(eng.apply('1', 'draw').ok).toBe(true);
    expect(eng.discardPile.map((x) => x.id)).toContain('黃_帥_1');
    expect(eng.turnSeat).toBe(1); // 換到 seat1（跳過相公）
  });
});

describe('吃牌窗等待秒數（建房選項）', () => {
  it('自訂 claimWindowMs 反映在吃牌窗截止時間與 viewFor', () => {
    const eng = setupNoClaimDiscard(false, 2000);
    expect(eng.claimWindowMs).toBe(2000);
    expect(eng.viewFor('1').claimWindowMs).toBe(2000);
    const before = Date.now();
    expect(eng.apply('0', 'discard', '黃_帥_1').ok).toBe(true);
    const wait = eng.claimEndsAt - before;
    expect(wait).toBeGreaterThan(1500);
    expect(wait).toBeLessThanOrEqual(2100);
  });
});
