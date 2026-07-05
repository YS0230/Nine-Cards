import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Card } from '@nine-cards/shared';
import { GameServer } from '../src/game/gameServer.js';

const c = (color: Card['color'], rank: Card['rank'], copy = 1): Card => ({
  id: `${color}_${rank}_${copy}`,
  color,
  rank,
});

// 全黃胡牌 9 張：配 pending 黃帥 即五對
const yellowNine = (): Card[] => [
  c('黃', '帥', 2),
  c('黃', '仕'), c('黃', '仕', 2),
  c('黃', '相'), c('黃', '相', 2),
  c('黃', '俥'), c('黃', '俥', 2),
  c('黃', '兵'), c('黃', '兵', 2),
];

describe('多局／續局（§4.2/§12）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('胡牌後累計分數保留、下一局由胡牌者當莊', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', false);
    gs.joinByCode(created.room!.code, 'B', 'sock1');
    const hostId = created.player!.id;
    const roomId = created.room!.id;
    gs.startGame(hostId);

    const room = gs.getRoom(roomId)!;
    const bId = room.players[1].id;

    // 佈置成 seat1 可胡 seat0 打出的黃帥（放槍：只有 seat0 付）
    const eng = room.engine!;
    eng.stage = 'CLAIM';
    eng.pending = { card: c('黃', '帥', 9), fromSeat: 0, kind: 'discard' };
    eng.turnSeat = 0;
    eng.claimOrder = [1];
    eng.eatHolder = null;
    eng.tentative = null;
    eng.claimId = 99;
    eng.claimEndsAt = Date.now() + 999_999;
    eng.roundResult = null;
    eng.players[1].hand = yellowNine();
    eng.players[1].melds = [];
    room.phase = 'PLAYING';

    const r = gs.action(bId, 'declareWin');
    expect(r.ok).toBe(true);
    expect(room.phase).toBe('FINISHED');
    // 一色 5 頭，放槍：seat0 -5、seat1 +5
    expect(room.scores.get(room.players[1].id)).toBe(5);
    expect(room.scores.get(room.players[0].id)).toBe(-5);
    expect(room.engine!.roundResult!.nextDealerSeat).toBe(1);

    // 續局計時器到 → 開下一局
    vi.advanceTimersByTime(6000);
    const room2 = gs.getRoom(roomId)!;
    expect(room2.phase).toBe('PLAYING');
    expect(room2.engine!.players[1].isDealer).toBe(true); // 胡牌者當莊
    // 累計分數跨局保留並帶入引擎視圖
    expect(room2.engine!.players[1].score).toBe(5);
    expect(room2.engine!.players[0].score).toBe(-5);
  });

  it('有人離台 → 停止續局（§13）', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', false);
    gs.joinByCode(created.room!.code, 'B', 'sock1');
    const hostId = created.player!.id;
    const roomId = created.room!.id;
    gs.startGame(hostId);
    const room = gs.getRoom(roomId)!;
    const bId = room.players[1].id;

    const eng = room.engine!;
    eng.stage = 'CLAIM';
    eng.pending = { card: c('黃', '帥', 9), fromSeat: 0, kind: 'discard' };
    eng.turnSeat = 0;
    eng.claimOrder = [1];
    eng.claimId = 99;
    eng.claimEndsAt = Date.now() + 999_999;
    eng.roundResult = null;
    eng.players[1].hand = yellowNine();
    room.phase = 'PLAYING';
    gs.action(bId, 'declareWin');

    gs.leaveRoom(hostId); // A 離台
    vi.advanceTimersByTime(6000);
    // 房間仍在（B 還在線），但不再自動續局
    const room2 = gs.getRoom(roomId)!;
    expect(room2.phase).toBe('FINISHED');
    expect(room2.nextHandTimer).toBeUndefined();
  });
});
