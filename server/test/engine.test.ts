import { describe, it, expect } from 'vitest';
import {
  buildDeck,
  isPair,
  countPairs,
  isWinningSet,
  hasMatch,
  type Card,
} from '@nine-cards/shared';
import { GameEngine } from '../src/game/engine.js';

const c = (color: Card['color'], rank: Card['rank'], copy = 1): Card => ({
  id: `${color}_${rank}_${copy}`,
  color,
  rank,
});

describe('牌組 buildDeck', () => {
  it('共 112 張', () => {
    expect(buildDeck()).toHaveLength(112);
  });
  it('每種牌各 4 張、id 皆唯一', () => {
    const deck = buildDeck();
    expect(new Set(deck.map((d) => d.id)).size).toBe(112);
    const yellowShuai = deck.filter((d) => d.color === '黃' && d.rank === '帥');
    expect(yellowShuai).toHaveLength(4);
  });
});

describe('配對規則（§8）', () => {
  it('同花同種才成對', () => {
    expect(isPair(c('黃', '帥'), c('黃', '帥', 2))).toBe(true);
    expect(isPair(c('黃', '帥'), c('紅', '帥'))).toBe(false); // 不同花色
    expect(isPair(c('黃', '帥'), c('黃', '仕'))).toBe(false); // 不同種
  });
  it('countPairs 三張只算一對（多的第 3 張算單張）', () => {
    expect(countPairs([c('綠', '將'), c('綠', '將', 2), c('綠', '將', 3)])).toBe(1);
  });
});

describe('胡牌牌型 isWinningSet（§3 五對）', () => {
  it('五對且皆成雙 → 胡', () => {
    const hand: Card[] = [
      c('黃', '帥'), c('黃', '帥', 2),
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
    ];
    expect(isWinningSet(hand)).toBe(true);
  });
  it('有單張 → 不胡', () => {
    const hand: Card[] = [
      c('黃', '帥'), c('黃', '帥', 2),
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('紅', '兵'), // 這兩張不同花，不成對
    ];
    expect(isWinningSet(hand)).toBe(false);
  });
  it('張數不是 10 → 不胡', () => {
    expect(isWinningSet([c('黃', '帥'), c('黃', '帥', 2)])).toBe(false);
  });
});

describe('引擎發牌（§5）', () => {
  it('莊家 10 張、其餘 9 張、牌堆 = 112 - 已發', () => {
    const seats = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
      { id: 'd', name: 'D' },
    ];
    const eng = new GameEngine(seats, 0);
    expect(eng.players[0].hand).toHaveLength(10); // 莊
    expect(eng.players[1].hand).toHaveLength(9);
    const dealt = eng.players.reduce((s, p) => s + p.hand.length, 0);
    expect(eng.deck.length).toBe(112 - dealt);
  });
});

describe('回合合法性', () => {
  const seats = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  it('開局時莊家可打牌，非莊家不能動作', () => {
    const eng = new GameEngine(seats, 0);
    expect(eng.legalActionsFor(0)).toContain('discard');
    expect(eng.legalActionsFor(1)).toEqual([]);
  });
  it('非當前玩家送出動作被拒', () => {
    const eng = new GameEngine(seats, 0);
    const res = eng.apply('b', 'discard', eng.players[1].hand[0].id);
    expect(res.ok).toBe(false);
  });
  it('莊家打牌後進入 CLAIM 或換人摸牌', () => {
    const eng = new GameEngine(seats, 0);
    const res = eng.apply('a', 'discard', eng.players[0].hand[0].id);
    expect(res.ok).toBe(true);
    expect(['CLAIM', 'DRAW']).toContain(eng.stage);
  });
});

describe('個人化視圖不外洩他人手牌', () => {
  it('viewFor 只含自己的暗牌內容', () => {
    const seats = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const eng = new GameEngine(seats, 0);
    const view = eng.viewFor('a');
    expect(view.you.hand.length).toBeGreaterThan(0);
    const other = view.players.find((p) => p.id === 'b')!;
    // 對手只給張數，不給牌內容
    expect(other).not.toHaveProperty('hand');
    expect(other.handCount).toBe(9);
  });
});

describe('hasMatch 判斷可吃', () => {
  it('手上有同花同種即可吃', () => {
    const hand = [c('黃', '帥'), c('綠', '將')];
    expect(hasMatch(hand, c('黃', '帥', 3))).toBe(true);
    expect(hasMatch(hand, c('紅', '帥'))).toBe(false);
  });
});

// 手動架設一個吃牌窗（繞過隨機發牌，直接測吃牌/搶吃/摸牌關窗邏輯）
function makeClaim(seats: number, order: number[], pendingFrom: number) {
  const eng = new GameEngine(
    Array.from({ length: seats }, (_, i) => ({ id: String(i), name: `P${i}` })),
    0,
  );
  eng.phase = 'PLAYING';
  eng.stage = 'CLAIM';
  eng.pending = { card: c('黃', '帥', 9), fromSeat: pendingFrom, kind: 'discard' };
  eng.turnSeat = pendingFrom;
  eng.claimOrder = order;
  eng.eatHolder = null;
  eng.tentative = null;
  eng.claimId = 42;
  eng.claimEndsAt = Date.now() + 999_999; // 尚未到兩秒
  eng.discardPile = [];
  return eng;
}

// 湊 9 張暗牌：一張 黃帥 + 四對，配上 pending 黃帥 即成五對胡牌
const winningNine = () => [
  c('黃', '帥', 2),
  c('紅', '仕'), c('紅', '仕', 2),
  c('綠', '將'), c('綠', '將', 2),
  c('白', '卒'), c('白', '卒', 2),
  c('黃', '兵'), c('黃', '兵', 2),
];

describe('吃牌窗（tentative eat / 搶吃 / 下家摸牌）', () => {
  it('CLAIM 中不提供「過」動作', () => {
    const eng = makeClaim(2, [1], 0);
    eng.players[1].hand = [c('黃', '帥', 1)];
    expect(eng.legalActionsFor(1)).not.toContain('pass');
  });

  it('下一家兩秒內不能摸牌，兩秒後才可以', () => {
    const eng = makeClaim(2, [1], 0);
    eng.players[1].hand = [c('綠', '將')]; // 不成對，僅測下家摸牌閘門
    eng.claimEndsAt = Date.now() + 999_999;
    expect(eng.legalActionsFor(1)).not.toContain('draw'); // 兩秒內
    eng.claimEndsAt = Date.now() - 1;
    expect(eng.legalActionsFor(1)).toContain('draw'); // 兩秒後
  });

  it('按吃 → 進 EATING、暫定公開對子、輪到吃牌者打牌', () => {
    const eng = makeClaim(3, [1], 0);
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')];
    const r = eng.apply('1', 'eat');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('EATING');
    expect(eng.eatHolder).toBe(1);
    expect(eng.players[1].melds).toHaveLength(1);
    expect(eng.legalActionsFor(1)).toContain('discard');
  });

  it('高優先者可搶吃、低優先者讓出（對子還原）', () => {
    const eng = makeClaim(3, [2, 1], 0); // claimOrder：seat2 優先於 seat1
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')];
    eng.players[2].hand = [c('黃', '帥', 2), c('白', '卒')];
    eng.apply('1', 'eat'); // 低優先先吃
    expect(eng.eatHolder).toBe(1);
    eng.apply('2', 'eat'); // 高優先搶
    expect(eng.eatHolder).toBe(2);
    expect(eng.players[2].melds).toHaveLength(1);
    expect(eng.players[1].melds).toHaveLength(0); // 讓出、還原
    expect(eng.players[1].hand.some((x) => x.rank === '帥')).toBe(true); // 配對牌歸還
  });

  it('低優先者不能搶高優先者', () => {
    const eng = makeClaim(3, [2, 1], 0);
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')];
    eng.players[2].hand = [c('黃', '帥', 2), c('白', '卒')];
    eng.apply('2', 'eat'); // 高優先先吃
    const r = eng.apply('1', 'eat'); // 低優先想搶 → 不允許
    expect(r.ok).toBe(false);
    expect(eng.eatHolder).toBe(2);
  });

  it('胡牌可搶吃（撤銷暫定吃、判胡）', () => {
    const eng = makeClaim(3, [2, 1], 0); // seat2 胡、seat1 吃
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')];
    eng.players[2].hand = winningNine();
    eng.apply('1', 'eat'); // seat1 暫定吃
    expect(eng.eatHolder).toBe(1);
    const r = eng.apply('2', 'declareWin'); // seat2 胡搶
    expect(r.ok).toBe(true);
    expect(eng.phase).toBe('FINISHED');
    expect(eng.winnerSeat).toBe(2);
    expect(eng.players[1].melds).toHaveLength(0); // 暫定吃被撤銷
  });

  it('吃牌者打出後 → 提交吃牌（對子保留）、離開暫定狀態', () => {
    const eng = makeClaim(2, [1], 0);
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將'), c('綠', '士')];
    eng.apply('1', 'eat'); // EATING，對子 [黃帥,黃帥]，手上剩 綠將/綠士
    const discardId = eng.players[1].hand[0].id;
    const r = eng.apply('1', 'discard', discardId);
    expect(r.ok).toBe(true);
    expect(eng.players[1].melds).toHaveLength(1); // 對子保留＝提交
    expect(eng.eatHolder).toBeNull();
  });
});

// 架設「seat1 摸到 黃帥、手上已有 黃帥 可自摸吃」的情境
function drawSetup() {
  const eng = new GameEngine(
    [
      { id: '0', name: 'P0' },
      { id: '1', name: 'P1' },
      { id: '2', name: 'P2' },
    ],
    0,
  );
  eng.phase = 'PLAYING';
  eng.stage = 'DRAW';
  eng.turnSeat = 1;
  eng.players[0].hand = [c('綠', '將'), c('綠', '士'), c('綠', '象')];
  eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將', 2), c('綠', '士', 2)];
  eng.players[2].hand = [c('白', '卒'), c('白', '車'), c('白', '馬')];
  const filler = Array.from({ length: 20 }, (_, i) => c('紅', '兵', i + 1));
  eng.deck = [c('黃', '帥', 2), ...filler]; // 牌堆頂＝可配對的黃帥
  eng.discardPile = [];
  return eng;
}

describe('自摸吃保護（不限時、下家不能先摸）', () => {
  it('自摸可吃且他家無胡 → 不限時、下家不能摸、摸牌者可吃/不吃', () => {
    const eng = drawSetup();
    const r = eng.apply('1', 'draw');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('CLAIM');
    expect(eng.protectedSelfEat).toBe(true);
    expect(eng.legalActionsFor(2)).not.toContain('draw'); // 下家不能摸
    const la1 = eng.legalActionsFor(1);
    expect(la1).toContain('eat');
    expect(la1).toContain('pass'); // 不吃＝打出摸到的牌
  });

  it('自摸吃 → 進 EATING、由摸牌者打牌、解除保護', () => {
    const eng = drawSetup();
    eng.apply('1', 'draw');
    const r = eng.apply('1', 'eat');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('EATING');
    expect(eng.eatHolder).toBe(1);
    expect(eng.protectedSelfEat).toBe(false);
  });

  it('自摸不吃（pass）且無他家可吃 → 摸到的牌落桌、換下家', () => {
    const eng = drawSetup();
    eng.apply('1', 'draw');
    const r = eng.apply('1', 'pass');
    expect(r.ok).toBe(true);
    expect(eng.discardPile.map((d) => `${d.color}${d.rank}`)).toContain('黃帥');
    expect(eng.turnSeat).toBe(2);
    expect(eng.stage).toBe('DRAW');
    expect(eng.protectedSelfEat).toBe(false);
  });

  it('若他家能胡摸出的牌 → 不啟用保護（改為限時窗）', () => {
    const eng = drawSetup();
    eng.players[2].hand = [
      c('黃', '帥', 3),
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將', 3), c('綠', '將', 4),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
    ];
    eng.apply('1', 'draw');
    expect(eng.protectedSelfEat).toBe(false);
    expect(eng.claimEndsAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
