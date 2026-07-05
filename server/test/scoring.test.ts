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

describe('抽五隻 drawFiveBonus（§9.2，符合條件＝與胡牌牌組任一種同種）', () => {
  it('前四張各 +1、命中兩張 → 2 頭', () => {
    const deck = [c('黃', '帥', 2), c('黃', '帥', 3), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3)];
    const r = drawFiveBonus(deck, [c('黃', '帥', 1)]);
    expect(r.qualifying).toBe(2);
    expect(r.heads).toBe(2);
    expect(r.cards).toHaveLength(5);
    expect(deck).toHaveLength(0); // 已消耗
  });
  it('第五張（最後一張）命中 → +2 頭', () => {
    const deck = [c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4), c('黃', '帥', 2)];
    const r = drawFiveBonus(deck, [c('黃', '帥', 1)]);
    expect(r.qualifying).toBe(1);
    expect(r.heads).toBe(2);
  });
  it('牌堆不足 5 張 → 有幾張算幾張', () => {
    const deck = [c('黃', '帥', 2), c('黃', '帥', 3)];
    const r = drawFiveBonus(deck, [c('黃', '帥', 1)]);
    expect(r.cards).toHaveLength(2);
    expect(r.heads).toBe(2);
  });
  it('命中牌組中非胡牌張的其他對子也加頭', () => {
    const deck = [c('黃', '仕', 3), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4)];
    const r = drawFiveBonus(deck, [c('黃', '帥', 1), c('黃', '仕', 1), c('黃', '仕', 2)]);
    expect(r.qualifying).toBe(1); // 黃仕在牌組中 → 加頭
    expect(r.heads).toBe(1);
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
    // 放槍不是自摸 → 前端不該播自摸音效
    expect(eng.winnerSelfDraw).toBe(false);
    expect(eng.viewFor('1').winnerSelfDraw).toBe(false);
  });

  it('自摸：全體付、可抽五隻（胡牌者手動一張一張抽）', () => {
    // 摸牌者胡自己摸的牌（fromSeat=1、kind=drawn）；牌堆頂兩張黃帥供抽五隻命中
    const eng = claimWin('drawn', 1, [c('黃', '帥', 3), c('黃', '帥', 4), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    // 胡牌後進入手動抽五隻，尚未結算
    expect(eng.stage).toBe('DRAW_FIVE');
    expect(eng.roundResult).toBeNull();
    // winnerSeat 一確定就同步標記自摸（跟胡牌當下播音效的時機一致，不必等抽五隻結算）
    expect(eng.winnerSelfDraw).toBe(true);
    expect(eng.viewFor('1').winnerSelfDraw).toBe(true);
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
    expect(rr.breakdown.colorCount).toBe(1); // 一色
    expect(rr.breakdown.selfDraw).toBe(1); // 自摸加一頭
    expect(rr.breakdown.drawFiveFront).toBe(2); // 對花：前兩張黃帥命中
    expect(rr.breakdown.drawFiveLast).toBe(0); // 尾椎：未命中
    expect(rr.heads).toBe(8); // 5（一色）＋1（自摸）＋2（抽五隻）
    const bySeat = Object.fromEntries(rr.payments.map((p) => [p.seat, p.delta]));
    expect(bySeat[1]).toBe(16); // 兩位付家各 8
    expect(bySeat[0]).toBe(-8);
    expect(bySeat[2]).toBe(-8);
  });

  it('他人摸牌被胡（非自摸）→ 不加自摸頭', () => {
    // fromSeat=0 摸牌、seat1 胡 → 全體付、可抽五隻，但無自摸加頭
    const eng = claimWin('drawn', 0, [c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4), c('紅', '兵', 5)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(eng.apply('1', 'drawFive').ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.category).toBe('胡（摸牌）');
    expect(rr.breakdown.selfDraw).toBe(0);
    expect(rr.heads).toBe(5); // 只有一色 5
    expect(eng.winnerSelfDraw).toBe(false); // 別人摸牌被胡，不是自摸 → 不播自摸音效
  });

  it('四色胡牌 → 直接 0 頭：不加自摸/胡開頭、也不抽五隻', () => {
    const eng = claimWin('drawn', 1, [c('黃', '帥', 3), c('黃', '帥', 4)]);
    // 手牌改為四種顏色的四對＋黃帥單張（配 pending 黃帥成第五對）
    eng.players[1].hand = [
      c('黃', '帥', 2),
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
    ];
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    // 不進抽五隻，直接結算
    expect(eng.stage).not.toBe('DRAW_FIVE');
    const rr = eng.roundResult!;
    expect(rr.heads).toBe(0);
    expect(rr.breakdown).toEqual({
      color: 0,
      colorCount: 4,
      huKai: 0,
      selfDraw: 0,
      drawFiveFront: 0,
      drawFiveLast: 0,
    });
    expect(rr.drawFive).toBeNull();
    expect(rr.payments.every((p) => p.delta === 0)).toBe(true);
    expect(rr.winnerSeat).toBe(1); // 仍算胡牌（下一局當莊）
    expect(rr.nextDealerSeat).toBe(1);
  });

  it('開手胡（含天胡走同一路徑）：無 selfDraw 情境 → winnerSelfDraw 維持 false', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DISCARD';
    eng.turnSeat = 0;
    eng.roundResult = null;
    eng.players[0].hand = yellowNine().concat(c('黃', '帥', 1)); // 湊滿五對，開手即胡
    const r = eng.apply('0', 'declareWin');
    expect(r.ok).toBe(true);
    expect(eng.winnerSelfDraw).toBe(false);
    expect(eng.viewFor('0').winnerSelfDraw).toBe(false);
  });

  it('抽五隻最後一張命中 → 加兩頭（手動抽）', () => {
    // 前四張不命中、第五張命中黃帥 → +2
    const eng = claimWin('drawn', 1, [c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4), c('黃', '帥', 3)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(eng.apply('1', 'drawFive').ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.breakdown.drawFiveFront).toBe(0);
    expect(rr.breakdown.drawFiveLast).toBe(2); // 尾椎：最後一張命中 +2
    expect(rr.drawFive!.marks).toEqual([false, false, false, false, true]);
  });

  it('抽五隻：抽中牌組中其他對子（非胡牌張）也加頭', () => {
    // 牌組含 黃仕 對子 → 抽到第三張黃仕也符合條件
    const eng = claimWin('drawn', 1, [c('黃', '仕', 3), c('紅', '兵'), c('紅', '兵', 2), c('紅', '兵', 3), c('紅', '兵', 4)]);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(eng.apply('1', 'drawFive').ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.drawFive!.marks).toEqual([true, false, false, false, false]); // 黃仕命中
    expect(rr.breakdown.drawFiveFront).toBe(1); // 對花
    expect(rr.breakdown.drawFiveLast).toBe(0);
    expect(rr.heads).toBe(7); // 5（一色）＋1（自摸）＋1（對花）
  });

  it('結算帶出胡牌者牌組（五對）與胡牌張', () => {
    const eng = claimWin('discard', 0, []);
    expect(eng.apply('1', 'declareWin').ok).toBe(true);
    const rr = eng.roundResult!;
    expect(rr.winningCard?.id).toBe('黃_帥_1');
    expect(rr.winnerHand).toHaveLength(10); // 五對
    // 依牌種排序 → 成對相鄰
    for (let i = 0; i < 10; i += 2) {
      expect(rr.winnerHand![i].color).toBe(rr.winnerHand![i + 1].color);
      expect(rr.winnerHand![i].rank).toBe(rr.winnerHand![i + 1].rank);
    }
  });
});
