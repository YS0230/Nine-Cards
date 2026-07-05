import { describe, it, expect } from 'vitest';
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

describe('多局／續局（§4.2/§12/§13）', () => {
  it('胡牌後累計分數保留、全員按繼續才開下一局、由胡牌者當莊', () => {
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

    // 只有一人按繼續 → 仍停留結算畫面
    gs.readyContinue(room.players[0].id);
    expect(gs.getRoom(roomId)!.phase).toBe('FINISHED');
    // 全員按繼續 → 開下一局
    gs.readyContinue(room.players[1].id);
    const room2 = gs.getRoom(roomId)!;
    expect(room2.phase).toBe('PLAYING');
    expect(room2.engine!.players[1].isDealer).toBe(true); // 胡牌者當莊
    // 累計分數跨局保留並帶入引擎視圖
    expect(room2.engine!.players[1].score).toBe(5);
    expect(room2.engine!.players[0].score).toBe(-5);
  });

  it('有人離開 → 整場結束、顯示最終計分版（§1）', () => {
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
    gs.action(bId, 'declareWin'); // B 胡牌：B +5、A -5

    gs.leaveRoom(hostId); // A 離開 → 整場結束
    const room2 = gs.getRoom(roomId)!;
    expect(room2.phase).toBe('ENDED');
    expect(room2.endResult).toBeTruthy();
    expect(room2.endResult!.leaverName).toBe('A');
    // 計分版依累計頭數由高到低排序：B(+5) 在前、A(-5) 在後
    const board = room2.endResult!.scores;
    expect(board[0].name).toBe('B');
    expect(board[0].total).toBe(5);
    expect(board[board.length - 1].name).toBe('A');
    expect(board[board.length - 1].total).toBe(-5);

    // 已結束後 B 想繼續應被拒（牌局已非 FINISHED）
    const cont = gs.readyContinue(bId);
    expect(cont.ok).toBe(false);
  });

  it('意外斷線 → 全體暫停，重連後解除暫停（§2）', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', false);
    gs.joinByCode(created.room!.code, 'B', 'sock1');
    const hostId = created.player!.id;
    const roomId = created.room!.id;
    gs.startGame(hostId);
    const room = gs.getRoom(roomId)!;
    room.phase = 'PLAYING';
    const bId = room.players[1].id;

    // B 意外斷線 → 暫停
    gs.markDisconnected('sock1');
    expect(room.paused).toBe(true);
    // 暫停中任何動作皆被擋
    expect(gs.action(hostId, 'draw').ok).toBe(false);

    // B 重連 → 解除暫停
    const res = gs.resume(room.players[1].token, 'sock1b');
    expect(res.ok).toBe(true);
    expect(room.paused).toBe(false);
    expect(room.players[1].connected).toBe(true);
    void bId;
  });
});
