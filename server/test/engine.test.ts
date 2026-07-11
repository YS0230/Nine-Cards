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

describe('持三張吃第四張（§8：四張全公開、排成一組）', () => {
  const tripleHand = () => [c('黃', '帥', 1), c('黃', '帥', 2), c('黃', '帥', 3), c('綠', '將')];

  it('按吃 → 三張連同吃進的牌成一組 4 張公開、暗手牌少 3 張', () => {
    const eng = makeClaim(2, [1], 0);
    eng.players[1].hand = tripleHand();
    const r = eng.apply('1', 'eat');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('EATING');
    expect(eng.players[1].melds).toHaveLength(1);
    expect(eng.players[1].melds[0]).toHaveLength(4); // 四張排成一組
    expect(eng.players[1].melds[0].every((x) => x.color === '黃' && x.rank === '帥')).toBe(true);
    expect(eng.players[1].hand).toHaveLength(1); // 只剩 綠將
    const view = eng.viewFor('0');
    expect(view.players.find((p) => p.id === '1')!.handCount).toBe(1);
  });

  it('高優先者搶吃 → 三張完整還原回暗手牌', () => {
    const eng = makeClaim(3, [2, 1], 0);
    eng.players[1].hand = tripleHand();
    eng.players[2].hand = [c('黃', '帥', 4), c('白', '卒')];
    eng.apply('1', 'eat'); // 低優先先吃（4 張公開）
    eng.apply('2', 'eat'); // 高優先搶
    expect(eng.eatHolder).toBe(2);
    expect(eng.players[1].melds).toHaveLength(0);
    expect(eng.players[1].hand).toHaveLength(4); // 三張帥＋綠將全數歸還
    expect(eng.players[1].hand.filter((x) => x.rank === '帥')).toHaveLength(3);
  });

  it('吃牌者打出 → 提交，4 張牌組保留', () => {
    const eng = makeClaim(2, [1], 0);
    eng.players[1].hand = [...tripleHand(), c('綠', '士')];
    eng.apply('1', 'eat');
    const r = eng.apply('1', 'discard', eng.players[1].hand[0].id);
    expect(r.ok).toBe(true);
    expect(eng.players[1].melds[0]).toHaveLength(4);
    expect(eng.eatHolder).toBeNull();
  });
});

// 與 winningNine 不撞 id 的另一副聽 黃帥 的手牌（一炮多響用）
const winningNineAlt = () => [
  c('黃', '帥', 3),
  c('紅', '仕', 3), c('紅', '仕', 4),
  c('綠', '將', 3), c('綠', '將', 4),
  c('白', '卒', 3), c('白', '卒', 4),
  c('黃', '兵', 3), c('黃', '兵', 4),
];

describe('一炮多響（§9.1 多家能胡同一張 → 依座位優先，暫定胡仲裁）', () => {
  // seat0 打出 黃帥；下家 seat3（距離 1）與 seat2（距離 2）都聽這張 → seat3 優先
  function multiHuSetup() {
    const eng = makeClaim(4, [3, 2], 0);
    eng.players[3].hand = winningNine();
    eng.players[2].hand = winningNineAlt();
    return eng;
  }

  it('低優先胡家先按 → 暫定胡（不立即定案），高優先胡家可搶胡定案', () => {
    const eng = multiHuSetup();
    const r = eng.apply('2', 'declareWin');
    expect(r.ok).toBe(true);
    expect(eng.phase).toBe('PLAYING'); // 尚未定案，等更高優先者
    expect(eng.winHolder).toBe(2);
    expect(eng.legalActionsFor(3)).toContain('declareWin'); // 高優先可搶胡
    expect(eng.legalActionsFor(2)).toEqual([]); // 暫定者只能等
    const r2 = eng.apply('3', 'declareWin'); // 最高優先搶胡 → 立即定案
    expect(r2.ok).toBe(true);
    expect(eng.phase).toBe('FINISHED');
    expect(eng.winnerSeat).toBe(3);
  });

  it('仲裁中下家不能摸牌（即使超過等待時間）', () => {
    const eng = multiHuSetup();
    eng.apply('2', 'declareWin');
    eng.claimEndsAt = Date.now() - 1; // 模擬計時器尚未觸發的空窗
    expect(eng.legalActionsFor(3)).not.toContain('draw'); // seat3 同時是下家
  });

  it('窗結束無人搶胡 → 暫定胡定案給宣告者', () => {
    const eng = multiHuSetup();
    eng.apply('2', 'declareWin');
    eng.finalizeHeldWin();
    expect(eng.phase).toBe('PLAYING'); // 時間未到 → 不定案
    eng.claimEndsAt = Date.now() - 1;
    eng.finalizeHeldWin();
    expect(eng.phase).toBe('FINISHED');
    expect(eng.winnerSeat).toBe(2);
  });

  it('最高優先胡家宣告 → 立即定案，不開仲裁窗', () => {
    const eng = multiHuSetup();
    const r = eng.apply('3', 'declareWin');
    expect(r.ok).toBe(true);
    expect(eng.phase).toBe('FINISHED');
    expect(eng.winnerSeat).toBe(3);
  });

  it('低優先胡家搶走暫定吃 → 進入仲裁、對子還原，窗結束才定案', () => {
    const eng = multiHuSetup();
    eng.players[1].hand = [c('黃', '帥', 5), c('綠', '士')];
    eng.claimOrder = [3, 2, 1]; // seat1 只能吃，排最後
    eng.apply('1', 'eat');
    expect(eng.stage).toBe('EATING');
    eng.apply('2', 'declareWin'); // 低優先胡家搶吃 → 暫定胡（胡 > 吃）
    expect(eng.stage).toBe('CLAIM');
    expect(eng.winHolder).toBe(2);
    expect(eng.players[1].melds).toHaveLength(0); // 暫定吃被撤銷
    eng.claimEndsAt = Date.now() - 1;
    eng.finalizeHeldWin();
    expect(eng.phase).toBe('FINISHED');
    expect(eng.winnerSeat).toBe(2);
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

  it('自摸不吃（pass）且無他家可吃 → 摸到的牌落桌、逆時鐘換下家', () => {
    const eng = drawSetup();
    eng.apply('1', 'draw');
    const r = eng.apply('1', 'pass');
    expect(r.ok).toBe(true);
    expect(eng.discardPile.map((d) => `${d.color}${d.rank}`)).toContain('黃帥');
    expect(eng.turnSeat).toBe(0); // 逆時鐘：seat1 的下家＝seat0
    expect(eng.stage).toBe('DRAW');
    expect(eng.protectedSelfEat).toBe(false);
  });

  it('若他家能胡摸出的牌（摸牌者只能吃） → 不啟用保護（改為限時窗）', () => {
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

// 架設「seat1 與 seat2 都聽 黃帥、seat1 摸到 黃帥」的情境（自摸最高優先）
function bothTenpaiSetup() {
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
  eng.players[0].hand = [c('綠', '士'), c('綠', '象'), c('紅', '車')];
  eng.players[1].hand = winningNine(); // 聽 黃帥
  eng.players[2].hand = [
    c('黃', '帥', 4),
    c('紅', '仕', 3), c('紅', '仕', 4),
    c('綠', '將', 5), c('綠', '將', 6),
    c('白', '卒', 3), c('白', '卒', 4),
    c('黃', '兵', 3), c('黃', '兵', 4),
  ]; // 也聽 黃帥
  const filler = Array.from({ length: 20 }, (_, i) => c('紅', '兵', i + 1));
  eng.deck = [c('黃', '帥', 9), ...filler]; // 牌堆頂＝兩家都聽的黃帥
  eng.discardPile = [];
  return eng;
}

describe('自摸最高優先（多家聽同一張牌）', () => {
  it('摸牌者能胡自己摸的牌 → 啟用保護，他家（也聽這張）不能先胡', () => {
    const eng = bothTenpaiSetup();
    const r = eng.apply('1', 'draw');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('CLAIM');
    expect(eng.protectedSelfEat).toBe(true);
    expect(eng.claimEndsAt).toBe(Number.MAX_SAFE_INTEGER); // 不限時
    expect(eng.legalActionsFor(1)).toContain('declareWin'); // 摸牌者可胡
    expect(eng.legalActionsFor(2)).toEqual([]); // 他家要等摸牌者決定
  });

  it('他家搶先送出胡牌 → 被拒；摸牌者胡 → 自摸成立', () => {
    const eng = bothTenpaiSetup();
    eng.apply('1', 'draw');
    const steal = eng.apply('2', 'declareWin');
    expect(steal.ok).toBe(false);
    const r = eng.apply('1', 'declareWin');
    expect(r.ok).toBe(true);
    expect(eng.winnerSeat).toBe(1); // 自摸最高優先
  });

  it('摸牌者不胡（pass） → 轉限時窗，他家才可胡', () => {
    const eng = bothTenpaiSetup();
    eng.apply('1', 'draw');
    const r = eng.apply('1', 'pass');
    expect(r.ok).toBe(true);
    expect(eng.protectedSelfEat).toBe(false);
    expect(eng.legalActionsFor(2)).toContain('declareWin');
    const win = eng.apply('2', 'declareWin');
    expect(win.ok).toBe(true);
    expect(eng.winnerSeat).toBe(2);
  });
});

// 架設「seat2 打出 黃帥(1)、seat0 手上還留著 黃帥(2) 可配對、吃牌窗已逾時」的情境
// 逆時鐘輪替：seat2 的下家＝seat1（可摸牌關窗）
function pairSetup() {
  const eng = new GameEngine(
    [
      { id: '0', name: 'P0' },
      { id: '1', name: 'P1' },
      { id: '2', name: 'P2' },
    ],
    0,
  );
  eng.phase = 'PLAYING';
  eng.stage = 'CLAIM';
  eng.pending = { card: c('黃', '帥', 1), fromSeat: 2, kind: 'discard' };
  eng.claimOrder = [0]; // seat0 可吃
  eng.claimId = 1;
  eng.claimEndsAt = Date.now() - 1; // 已逾時 → 下家（seat1）可摸牌
  eng.players[0].hand = [c('黃', '帥', 2), c('綠', '士')];
  eng.players[1].hand = [c('綠', '將')];
  eng.players[2].hand = [c('白', '卒')];
  eng.deck = Array.from({ length: 30 }, (_, i) => c('紅', '兵', i + 1));
  eng.discardPile = [];
  return eng;
}

describe('相公（棄牌落桌時暗牌仍可配對卻未吃走 → 本局僅能觀看）', () => {
  it('棄牌落桌後手上有配對卻沒吃 → 相公，不能再做任何動作', () => {
    const eng = pairSetup();
    const r = eng.apply('1', 'draw'); // 下家 seat1 摸牌 → 關閉吃牌窗，黃帥(1) 落棄牌堆
    expect(r.ok).toBe(true);
    expect(eng.discardPile.map((x) => x.id)).toContain('黃_帥_1');
    expect(eng.xianggong[0]).toBe(true); // seat0 手上黃帥(2) 可配對卻沒吃 → 相公
    expect(eng.legalActionsFor(0)).toEqual([]); // 僅能觀看
    expect(eng.apply('0', 'eat').ok).toBe(false);
  });

  it('相公被跳過：輪替不會輪到相公摸牌', () => {
    const eng = pairSetup();
    eng.apply('1', 'draw'); // seat0 成相公；seat1 摸出紅兵（無人可吃 → 直接落桌）
    expect(eng.stage).toBe('DRAW');
    expect(eng.turnSeat).toBe(2); // seat1 的下家＝相公 seat0 → 跳過，輪到 seat2
  });

  it('相公不會再被列入吃牌窗（打出可吃的牌也不開窗）', () => {
    const eng = pairSetup();
    eng.apply('1', 'draw'); // seat0 成相公（手上仍有黃帥可配對）
    // 改由 seat1 出牌：打出黃帥 → 只有相公 seat0 有配對，仍不開吃牌窗，直接落桌
    eng.stage = 'DISCARD';
    eng.turnSeat = 1;
    eng.players[1].hand = [c('黃', '帥', 3), c('綠', '將')];
    const r = eng.apply('1', 'discard', '黃_帥_3');
    expect(r.ok).toBe(true);
    expect(eng.stage).toBe('DRAW'); // 無人可吃 → 直接換下一位（跳過相公 seat0）
    expect(eng.turnSeat).toBe(2);
  });

  it('主動選擇摸牌放棄吃，只要暗牌仍配得到棄牌一樣算相公（不再區分主動或逾時）', () => {
    const eng = pairSetup();
    eng.claimOrder = [1]; // 下家 seat1 自己可吃
    eng.players[1].hand = [c('黃', '帥', 2), c('綠', '將')];
    eng.players[0].hand = [c('綠', '士')];
    const r = eng.apply('1', 'draw'); // 選擇摸牌放棄吃
    expect(r.ok).toBe(true);
    expect(eng.xianggong[1]).toBe(true); // 手上仍配得到剛落桌的黃帥 → 相公
  });

  it('手上沒有配對就不算相公', () => {
    const eng = pairSetup();
    eng.claimOrder = [];
    eng.players[0].hand = [c('綠', '士')]; // 手上沒有黃帥
    const r = eng.apply('1', 'draw');
    expect(r.ok).toBe(true);
    expect(eng.xianggong.every((x) => !x)).toBe(true);
  });

  it('全員因此都相公、無人能繼續 → 比照牌堆不足九支，流局重新發牌', () => {
    const eng = pairSetup();
    // 黃帥(1) 落桌時，seat0/1/2 手上剛好都還留著黃帥的另一張 → 三家同時相公
    eng.players[1].hand = [c('黃', '帥', 3)];
    eng.players[2].hand = [c('黃', '帥', 4)];
    const r = eng.apply('1', 'draw');
    expect(r.ok).toBe(true);
    expect(eng.xianggong).toEqual([true, true, true]);
    expect(eng.phase).toBe('FINISHED');
    expect(eng.drawGame).toBe(true);
    expect(eng.roundResult?.reason).toBe('draw');
  });
});
