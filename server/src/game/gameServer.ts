// 房間、配對與玩家身分管理（不直接碰 socket，交由 index.ts 廣播）
import { randomUUID } from 'node:crypto';
import { GameEngine, type SeatInit } from './engine.js';
import type { ActionType, RoomView, RoomPhase, LobbyRoom } from '@nine-cards/shared';

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;

export interface Player {
  id: string;
  name: string;
  token: string; // 重連用秘鑰
  seat: number; // 座位索引（開局後 0..k-1）
  socketId: string | null;
  connected: boolean;
}

export interface Room {
  id: string;
  code: string;
  isPublic: boolean;
  phase: RoomPhase;
  players: Player[]; // 依加入順序，開局後 seat 對齊索引
  hostId: string | null;
  engine: GameEngine | null;
  lastDealerSeat: number;
  claimTimer?: ReturnType<typeof setTimeout>;
  scheduledClaimId?: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  room?: Room;
}

export interface JoinOutcome {
  ok: boolean;
  error?: string;
  room?: Room;
  player?: Player;
}

function makeCode(existing: Set<string>): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (existing.has(code));
  return code;
}

export class GameServer {
  private rooms = new Map<string, Room>();
  private codeIndex = new Map<string, string>(); // code → roomId
  private tokenIndex = new Map<string, { roomId: string; playerId: string }>();
  private broadcast?: (room: Room) => void;

  // index.ts 注入廣播函式，讓時間窗到時的自動結算也能推播新狀態
  setBroadcaster(fn: (room: Room) => void) {
    this.broadcast = fn;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  findRoomByPlayer(playerId: string): Room | undefined {
    for (const r of this.rooms.values()) {
      if (r.players.some((p) => p.id === playerId)) return r;
    }
    return undefined;
  }

  private newPlayer(name: string, socketId: string, seat: number): Player {
    return {
      id: randomUUID(),
      name: name.trim().slice(0, 12) || '玩家',
      token: randomUUID(),
      seat,
      socketId,
      connected: true,
    };
  }

  createRoom(name: string, socketId: string, isPublic = false): JoinOutcome {
    const id = randomUUID();
    const code = makeCode(new Set(this.codeIndex.keys()));
    const host = this.newPlayer(name, socketId, 0);
    const room: Room = {
      id,
      code,
      isPublic,
      phase: 'WAITING',
      players: [host],
      hostId: host.id,
      engine: null,
      lastDealerSeat: 0,
    };
    this.rooms.set(id, room);
    this.codeIndex.set(code, id);
    this.tokenIndex.set(host.token, { roomId: id, playerId: host.id });
    return { ok: true, room, player: host };
  }

  joinByCode(code: string, name: string, socketId: string): JoinOutcome {
    const roomId = this.codeIndex.get(code.toUpperCase().trim());
    if (!roomId) return { ok: false, error: '找不到這個房號' };
    return this.joinRoom(roomId, name, socketId);
  }

  private joinRoom(roomId: string, name: string, socketId: string): JoinOutcome {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.phase !== 'WAITING') return { ok: false, error: '牌局已開始，無法加入' };
    if (room.players.length >= MAX_PLAYERS) return { ok: false, error: '房間已滿' };
    const player = this.newPlayer(name, socketId, room.players.length);
    room.players.push(player);
    this.tokenIndex.set(player.token, { roomId: room.id, playerId: player.id });
    return { ok: true, room, player };
  }

  quickMatch(name: string, socketId: string): JoinOutcome {
    // 找一個公開、等待中、有空位的房間；沒有就開一個公開房
    for (const room of this.rooms.values()) {
      if (room.isPublic && room.phase === 'WAITING' && room.players.length < MAX_PLAYERS) {
        return this.joinRoom(room.id, name, socketId);
      }
    }
    return this.createRoom(name, socketId, true);
  }

  resume(token: string, socketId: string): JoinOutcome {
    const ref = this.tokenIndex.get(token);
    if (!ref) return { ok: false, error: '連線已失效，請重新加入' };
    const room = this.rooms.get(ref.roomId);
    const player = room?.players.find((p) => p.id === ref.playerId);
    if (!room || !player) return { ok: false, error: '房間已不存在' };
    player.socketId = socketId;
    player.connected = true;
    room.engine?.setConnected(player.id, true);
    return { ok: true, room, player };
  }

  startGame(playerId: string): ActionResult {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, error: '不在任何房間' };
    if (room.hostId !== playerId) return { ok: false, error: '只有房主可以開始' };
    if (room.phase !== 'WAITING') return { ok: false, error: '牌局已開始' };
    if (room.players.length < MIN_PLAYERS) return { ok: false, error: '至少需要 2 位玩家' };

    // 開局：把座位壓實成 0..k-1，讓引擎座位對齊
    room.players.forEach((p, i) => (p.seat = i));
    const seats: SeatInit[] = room.players.map((p) => ({ id: p.id, name: p.name }));
    // MVP：隨機決定莊家（完整版做 §4.1 抽牌比權重/顏色）
    const dealerSeat = Math.floor(Math.random() * seats.length);
    room.lastDealerSeat = dealerSeat;
    room.engine = new GameEngine(seats, dealerSeat);
    room.phase = 'PLAYING';
    this.scheduleClaim(room);
    return { ok: true, room };
  }

  action(playerId: string, type: ActionType, cardId?: string): ActionResult {
    const room = this.findRoomByPlayer(playerId);
    if (!room || !room.engine) return { ok: false, error: '目前沒有進行中的牌局' };
    const res = room.engine.apply(playerId, type, cardId);
    if (!res.ok) return { ok: false, error: res.error, room };
    if (room.engine.phase === 'FINISHED') room.phase = 'FINISHED';
    this.scheduleClaim(room);
    return { ok: true, room };
  }

  // 開著吃牌窗時排一個計時器：兩秒到就重推狀態，讓下一家的「摸牌」按鈕變可用（不自動結算）
  private scheduleClaim(room: Room) {
    const eng = room.engine;
    if (!eng || eng.stage !== 'CLAIM') {
      if (room.claimTimer) clearTimeout(room.claimTimer);
      room.claimTimer = undefined;
      room.scheduledClaimId = undefined;
      return;
    }
    if (room.scheduledClaimId === eng.claimId) return; // 這個窗已排程
    if (room.claimTimer) clearTimeout(room.claimTimer);
    room.scheduledClaimId = eng.claimId;
    const delay = eng.claimEndsAt - Date.now();
    if (delay > 60_000) return; // 自摸保護：不限時，不需計時器
    room.claimTimer = setTimeout(() => {
      room.claimTimer = undefined;
      this.broadcast?.(room);
    }, Math.max(0, delay) + 60);
  }

  markDisconnected(socketId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      const player = room.players.find((p) => p.socketId === socketId);
      if (!player) continue;
      player.connected = false;
      player.socketId = null;
      room.engine?.setConnected(player.id, false);
      // 若整桌都離線且未開局，回收房間
      if (room.players.every((p) => !p.connected) && room.phase === 'WAITING') {
        this.disposeRoom(room);
        return undefined;
      }
      return room;
    }
    return undefined;
  }

  private disposeRoom(room: Room) {
    if (room.claimTimer) clearTimeout(room.claimTimer);
    this.rooms.delete(room.id);
    this.codeIndex.delete(room.code);
    for (const p of room.players) this.tokenIndex.delete(p.token);
  }

  // 公開大廳：所有公開、等待中、有空位的房間摘要
  publicLobby(): LobbyRoom[] {
    const list: LobbyRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.isPublic && room.phase === 'WAITING' && room.players.length < MAX_PLAYERS) {
        list.push({
          code: room.code,
          hostName: room.players.find((p) => p.id === room.hostId)?.name ?? '房主',
          count: room.players.length,
          maxPlayers: MAX_PLAYERS,
        });
      }
    }
    return list;
  }

  roomView(room: Room): RoomView {
    const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const p = room.players[i];
      return p
        ? { playerId: p.id, name: p.name, connected: p.connected }
        : { playerId: null, name: null, connected: false };
    });
    return {
      roomId: room.id,
      code: room.code,
      phase: room.phase,
      isPublic: room.isPublic,
      seats,
      hostId: room.hostId,
      maxPlayers: MAX_PLAYERS,
    };
  }
}
