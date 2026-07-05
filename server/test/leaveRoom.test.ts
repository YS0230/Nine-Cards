import { describe, it, expect } from 'vitest';
import { GameServer } from '../src/game/gameServer.js';

describe('等待房離開（按「離開」需真正釋出座位，而非等同斷線）', () => {
  it('非房主離開等待房 → 從玩家清單移除、座位壓實、房間保留', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', true);
    const roomId = created.room!.id;
    const joinB = gs.joinByCode(created.room!.code, 'B', 'sock1');
    const joinC = gs.joinByCode(created.room!.code, 'C', 'sock2');
    const bId = joinB.player!.id;

    const room = gs.leaveRoom(bId)!;
    expect(room).toBeTruthy();
    // B 已徹底移除，不是仍留在清單中標記斷線
    expect(room.players.find((p) => p.id === bId)).toBeUndefined();
    expect(room.players).toHaveLength(2);
    // 座位壓實（0..1），供下一位加入對齊
    expect(room.players.map((p) => p.seat)).toEqual([0, 1]);
    expect(room.players.map((p) => p.name)).toEqual(['A', 'C']);
    // 房主不變
    expect(room.hostId).toBe(created.player!.id);
    // 座位釋出後，新玩家可加入且拿到座位 2（原本會因人數判滿而被擋）
    const joinD = gs.joinByCode(room.code, 'D', 'sock3');
    expect(joinD.ok).toBe(true);
    expect(joinD.player!.seat).toBe(2);
    void roomId;
  });

  it('房主離開等待房 → 交棒給下一位玩家，房間保留', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', false);
    const joinB = gs.joinByCode(created.room!.code, 'B', 'sock1');
    const hostId = created.player!.id;
    const bId = joinB.player!.id;

    const room = gs.leaveRoom(hostId)!;
    expect(room).toBeTruthy();
    expect(room.players.find((p) => p.id === hostId)).toBeUndefined();
    expect(room.hostId).toBe(bId); // 交棒給剩下唯一的玩家
  });

  it('最後一人離開等待房 → 房間回收（之後房號查無此房）', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', false);
    const hostId = created.player!.id;
    const roomId = created.room!.id;

    const result = gs.leaveRoom(hostId);
    expect(result).toBeUndefined(); // 房間已回收
    expect(gs.getRoom(roomId)).toBeUndefined();
    const rejoin = gs.joinByCode(created.room!.code, 'X', 'sock9');
    expect(rejoin.ok).toBe(false); // 房號已失效
  });

  it('公開大廳清單即時反映離開後的人數（不再殘留斷線者佔位）', () => {
    const gs = new GameServer();
    gs.setBroadcaster(() => {});
    const created = gs.createRoom('A', 'sock0', true);
    const joinB = gs.joinByCode(created.room!.code, 'B', 'sock1');
    gs.leaveRoom(joinB.player!.id);
    const lobby = gs.publicLobby();
    const entry = lobby.find((r) => r.code === created.room!.code)!;
    expect(entry.count).toBe(1); // 只剩房主，不是「2 人（1 人已斷線）」
  });
});
