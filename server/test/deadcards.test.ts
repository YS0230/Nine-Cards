import { describe, it, expect } from 'vitest';
import { isTenpai, type Card } from '@nine-cards/shared';
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

describe('聽牌 isTenpai（§7）', () => {
  it('四對＋一單張（9 張）→ 聽牌', () => {
    const owned = [
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
      c('黃', '帥'), // 單張，等 黃帥 成對
    ];
    expect(isTenpai(owned)).toBe(true);
  });
  it('張數不是 9 → 非聽牌', () => {
    expect(isTenpai([c('黃', '帥'), c('黃', '帥', 2)])).toBe(false);
  });
  it('引擎在玩家聽牌時把 tenpai[seat] 設為 true', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DISCARD';
    eng.turnSeat = 0;
    eng.roundResult = null;
    // 莊家 10 張：四對 ＋ 黃帥單張 ＋ 一張要打掉的 白車
    eng.players[0].hand = [
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
      c('黃', '帥'),
      c('白', '車'),
    ];
    eng.players[0].deadIds = [];
    const r = eng.apply('0', 'discard', c('白', '車').id);
    expect(r.ok).toBe(true);
    expect(eng.tenpai[0]).toBe(true); // 打掉單張後聽 黃帥
  });
});

describe('死牌形成與強制出牌（§7.2/7.3）', () => {
  it('提交吃牌時，其他能吃卻沒吃到的玩家 → 該配對牌成死牌', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'CLAIM';
    eng.pending = { card: c('黃', '帥', 9), fromSeat: 0, kind: 'discard' };
    eng.turnSeat = 0;
    eng.claimOrder = [1, 2]; // seat1、seat2 都能吃
    eng.eatHolder = null;
    eng.tentative = null;
    eng.claimId = 1;
    eng.claimEndsAt = Date.now() + 999_999;
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將'), c('綠', '士')];
    eng.players[2].hand = [c('黃', '帥', 2), c('白', '卒'), c('白', '車')];

    eng.apply('1', 'eat'); // seat1 取得吃牌
    expect(eng.stage).toBe('EATING');
    const discardId = eng.players[1].hand.find((x) => x.rank === '將')!.id;
    eng.apply('1', 'discard', discardId); // 提交吃牌
    // seat2 沒吃到 → 黃帥 成死牌並公開
    expect(eng.players[2].deadIds).toHaveLength(1);
    const view2 = eng.viewFor('2');
    const pub2 = view2.players.find((p) => p.seat === 2)!;
    expect(pub2.deadCards.map((d) => `${d.color}${d.rank}`)).toContain('黃帥');
    expect(pub2.handCount).toBe(2); // 死牌不算暗牌張數
  });

  it('吃牌時：一般手牌配對 → eating.matchedDeadCard 為 false（前端播「吃」）', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'CLAIM';
    eng.pending = { card: c('黃', '帥', 9), fromSeat: 0, kind: 'discard' };
    eng.turnSeat = 0;
    eng.claimOrder = [1];
    eng.eatHolder = null;
    eng.tentative = null;
    eng.claimId = 1;
    eng.claimEndsAt = Date.now() + 999_999;
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')]; // 一般手牌，非死牌
    eng.players[1].deadIds = [];

    expect(eng.apply('1', 'eat').ok).toBe(true);
    expect(eng.viewFor('1').eating).toEqual({ seat: 1, card: c('黃', '帥', 9), matchedDeadCard: false });
  });

  it('吃牌時：用手中死牌就地湊對（§7.2）→ eating.matchedDeadCard 為 true（前端播「撿」），且死牌狀態解除', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'CLAIM';
    eng.pending = { card: c('黃', '帥', 9), fromSeat: 0, kind: 'discard' };
    eng.turnSeat = 0;
    eng.claimOrder = [1];
    eng.eatHolder = null;
    eng.tentative = null;
    eng.claimId = 1;
    eng.claimEndsAt = Date.now() + 999_999;
    eng.players[1].hand = [c('黃', '帥', 1), c('綠', '將')];
    eng.players[1].deadIds = [c('黃', '帥', 1).id]; // 黃帥是死牌，等待配對

    expect(eng.apply('1', 'eat').ok).toBe(true);
    expect(eng.viewFor('1').eating).toEqual({ seat: 1, card: c('黃', '帥', 9), matchedDeadCard: true });
    expect(eng.players[1].deadIds).toHaveLength(0); // 就地成對，解除死牌狀態
  });

  it('有死牌時，必須先打出死牌（先進先出）；錯誤訊息需點名正確的那張', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DISCARD';
    eng.turnSeat = 0;
    eng.roundResult = null;
    eng.players[0].hand = [
      c('黃', '帥'), c('紅', '仕'), c('綠', '將'), c('白', '卒'),
      c('黃', '兵'), c('紅', '炮'), c('綠', '包'), c('白', '馬'),
      c('黃', '相'), c('紅', '傌'),
    ];
    // 兩張死牌：黃帥（front）、紅仕
    eng.players[0].deadIds = [c('黃', '帥').id, c('紅', '仕').id];
    // 打非死牌 → 被拒，且訊息點名唯一該打的那張（先進先出＝黃帥）
    const bad = eng.apply('0', 'discard', c('綠', '將').id);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('黃帥');
    expect(bad.error).not.toContain('紅仕'); // 不該點名尚未輪到的死牌
    // 誤打「另一張死牌」（順序不對）也要被拒，且同樣點名正確的黃帥
    const wrongOrder = eng.apply('0', 'discard', c('紅', '仕').id);
    expect(wrongOrder.ok).toBe(false);
    expect(wrongOrder.error).toContain('黃帥');
    // viewFor 需帶出「此刻真正可打」的死牌 id，供前端只解鎖正確那張
    expect(eng.viewFor('0').you.forcedDiscardIds).toEqual([c('黃', '帥').id]);
    // 打先進先出的死牌 → 允許
    const ok = eng.apply('0', 'discard', c('黃', '帥').id);
    expect(ok.ok).toBe(true);
  });

  it('沒有死牌時 forcedDiscardIds 為 null（不限制）', () => {
    const eng = new GameEngine(seats3, 0);
    eng.players[0].deadIds = [];
    expect(eng.viewFor('0').you.forcedDiscardIds).toBeNull();
  });

  it('兩張死牌、改出另一張後聽牌 → 可不照先進先出，且兩張皆列為可選', () => {
    const eng = new GameEngine(seats3, 0);
    eng.phase = 'PLAYING';
    eng.stage = 'DISCARD';
    eng.turnSeat = 0;
    eng.roundResult = null;
    // 四對 ＋ 兩張單張（皆為死牌）；打掉任一單張都會聽牌
    eng.players[0].hand = [
      c('紅', '仕'), c('紅', '仕', 2),
      c('綠', '將'), c('綠', '將', 2),
      c('白', '卒'), c('白', '卒', 2),
      c('黃', '兵'), c('黃', '兵', 2),
      c('黃', '帥'), // 死牌 front
      c('黃', '仕'), // 死牌 second
    ];
    eng.players[0].deadIds = [c('黃', '帥').id, c('黃', '仕').id];
    // 例外成立：兩張死牌皆可選，前端據此才不會鎖住第二張
    const forced = eng.viewFor('0').you.forcedDiscardIds!;
    expect(new Set(forced)).toEqual(new Set([c('黃', '帥').id, c('黃', '仕').id]));
    // 打第二張死牌（非 front）→ 因打完聽牌，允許
    const r = eng.apply('0', 'discard', c('黃', '仕').id);
    expect(r.ok).toBe(true);
    expect(eng.tenpai[0]).toBe(true);
  });
});
