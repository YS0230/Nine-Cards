import { describe, it, expect } from 'vitest';
import {
  colorScore,
  huKaiBonus,
  drawFiveBonus,
  cardDrawStrength,
  pickDealerByDraw,
  type Card,
} from '@nine-cards/shared';
import { GameEngine } from '../src/game/engine.js';

const c = (color: Card['color'], rank: Card['rank'], copy = 1): Card => ({
  id: `${color}_${rank}_${copy}`,
  color,
  rank,
});

describe('顏色計分 colorScore（§11）', () => {
  it('一色 5、兩色 3、三色 2、四色 0', () => {
    expect(colorScore([c('黃', '帥'), c('黃', '仕')])).toBe(5);
    expect(colorScore([c('黃', '帥'), c('紅', '仕')])).toBe(3);
    expect(colorScore([c('黃', '帥'), c('紅', '仕'), c('綠', '將')])).toBe(2);
    expect(colorScore([c('黃', '帥'), c('紅', '仕'), c('綠', '將'), c('白', '卒')])).toBe(0);
  });
});

describe('胡開 huKaiBonus（§10.1）', () => {
  it('暗手三張同種、胡第 4 張 → 加 5 頭', () => {
    const handBefore = [c('黃', '帥', 1), c('黃', '帥', 2), c('黃', '帥', 3), c('紅', '仕')];
    expect(huKaiBonus(handBefore, [], c('黃', '帥', 4))).toBe(5);
  });
  it('吃牌達到四張同種（有 meld）→ 加 1 頭', () => {
    const handBefore = [c('黃', '帥', 3)];
    const melds = [[c('黃', '帥', 1), c('黃', '帥', 2)]];
    expect(huKaiBonus(handBefore, melds, c('黃', '帥', 4))).toBe(1);
  });
  it('胡的不是第 4 張 → 0', () => {
    expect(huKaiBonus([c('黃', '帥', 1)], [], c('黃', '帥', 2))).toBe(0);
  });
  it('無胡牌張（天胡）→ 0', () => {
    expect(huKaiBonus([c('黃', '帥', 1)], [], null)).toBe(0);
  });
});

describe('抽五隻 drawFiveBonus（§9.2，符合條件＝與胡的那張同種）', () => {
  it('前四張各 +1、命中兩張 → 2 頭', () => {
    const deck = [c('黃', '帥', 2), c('黃', '帥', 3), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3)];
    const r = drawFiveBonus(deck, c('黃', '帥', 1));
    expect(r.qualifying).toBe(2);
    expect(r.heads).toBe(2);
    expect(r.cards).toHaveLength(5);
    expect(deck).toHaveLength(0); // 已消耗
  });
  it('第五張（最後一張）命中 → +2 頭', () => {
    const deck = [c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4), c('黃', '帥', 2)];
    const r = drawFiveBonus(deck, c('黃', '帥', 1));
    expect(r.qualifying).toBe(1);
    expect(r.heads).toBe(2);
  });
  it('牌堆不足 5 張 → 有幾張算幾張', () => {
    const deck = [c('黃', '帥', 2), c('黃', '帥', 3)];
    const r = drawFiveBonus(deck, c('黃', '帥', 1));
    expect(r.cards).toHaveLength(2);
    expect(r.heads).toBe(2);
  });
});

describe('抽牌決定莊家（§4.1）', () => {
  it('cardDrawStrength：先比權重、再比顏色', () => {
    expect(cardDrawStrength(c('白', '帥'))).toBeGreaterThan(cardDrawStrength(c('黃', '仕'))); // 權重優先
    expect(cardDrawStrength(c('黃', '帥'))).toBeGreaterThan(cardDrawStrength(c('紅', '帥'))); // 同權重比顏色
  });
  it('回傳合法座位與每座位的抽牌', () => {
    const { dealerSeat, draws } = pickDealerByDraw(4, () => 0.5);
    expect(dealerSeat).toBeGreaterThanOrEqual(0);
    expect(dealerSeat).toBeLessThan(4);
    expect(draws).toHaveLength(4);
  });
});

// ── 引擎結算：付款分配（§11 勝負計算）───────────────────────
const seats3 = [
  { id: '0', name: 'P0' },
  { id: '1', name: 'P1' },
  { id: '2', name: 'P2' },
];
// 全黃胡牌 9 張：配上 pending 黃帥 即成五對（單一顏色 → colorScore 5）
const yellowNine = (): Card[] => [
  c('黃', '帥', 2),
  c('黃', '仕'), c('黃', '仕', 2),
  c('黃', '相'), c('黃', '相', 2),
  c('黃', '俥'), c('黃', '俥', 2),
  c('黃', '兵'), c('黃', '兵', 2),
];

function claimWin(kind: 'drawn' | 'discard', fromSeat: number, deck: Card[]) {
  const eng = new GameEngine(seats3, 0);
  eng.phase = 'PLAYING';
  eng.stage = 'CLAIM';
  eng.pending = { card: c('黃', '帥', 1), fromSeat, kind };
  eng.turnSeat = fromSeat;
  eng.claimOrder = [1];
  eng.eatHolder = null;
  eng.tentative = null;
  eng.claimId = 1;
  eng.claimEndsAt = Date.now() + 999_999;
  eng.deck = deck;
  eng.players[1].hand = yellowNine();
  eng.players[1].melds = [];
  return eng;
}

describe('付款分配', () => {
  it('放槍（打牌被胡）：只有放槍者付、不能抽五隻', () => {
    const eng = claimWin('discard', 0, [c('黃', '帥', 3)]);
    const r = eng.apply('1', 'declareWin');
    expect(r.ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.category).toBe('胡（放槍）');
    expect(rr.heads).toBe(5); // 一色 5，無胡開/抽五隻
    expect(rr.drawFive).toBeNull();
    const bySeat = Object.fromEntries(rr.payments.map((p) => [p.seat, p.delta]));
    expect(bySeat[1]).toBe(5); // 贏家收 1 位付家 × 5
    expect(bySeat[0]).toBe(-5); // 放槍者付
    expect(bySeat[2]).toBe(0); // 其他人不付
  });

  it('自摸：全體付、可抽五隻（胡牌者手動一張一張抽）', () => {
    // 摸牌者胡自己摸的牌（fromSeat=1、kind=drawn）；牌堆頂兩張黃帥供抽五隻命中
    const eng = claimWin('drawn', 1, [c('黃', '帥', 3), c('黃', '帥', 4), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    // 胡牌後進入手動抽五隻，尚未結算
    expect(eng.stage).toBe('DRAW_FIVE');
    expect(eng.roundResult).toBeNull();
    // 只有胡牌者能抽；他家不能
    expect(eng.apply('2', 'drawFive').ok).toBe(false);
    // 胡牌者一張一張抽，抽滿五張才結算
    for (let i = 0; i < 5; i++) {
      expect(eng.roundResult).toBeNull();
      expect(eng.apply('1', 'drawFive').ok).toBe(true);
    }
    const rr = eng.roundResult!;
    expect(rr.category).toBe('自摸');
    expect(rr.drawFive).not.toBeNull();
    expect(rr.drawFive!.marks).toEqual([true, true, false, false, false]); // 前兩張黃帥加頭
    expect(rr.breakdown.color).toBe(5);
    expect(rr.breakdown.drawFive).toBe(2); // 命中兩張黃帥
    expect(rr.heads).toBe(7);
    const bySeat = Object.fromEntries(rr.payments.map((p) => [p.seat, p.delta]));
    expect(bySeat[1]).toBe(14); // 兩位付家各 7
    expect(bySeat[0]).toBe(-7);
    expect(bySeat[2]).toBe(-7);
  });

  it('抽五隻最後一張命中 → 加兩頭（手動抽）', () => {
    // 前四張不命中、第五張命中黃帥 → +2
    const eng = claimWin('drawn', 1, [c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4), c('黃', '帥', 3)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(eng.apply('1', 'drawFive').ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.breakdown.drawFive).toBe(2); // 最後一張命中 +2
    expect(rr.drawFive!.marks).toEqual([false, false, false, false, true]);
  });
});
