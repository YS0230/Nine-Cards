// 房間、配對與玩家身分管理（不直接碰 socket，交由 index.ts 廣播）
import { randomUUID } from 'node:crypto';
import { GameEngine, type SeatInit } from './engine.js';
import type { ActionType, RoomView, RoomPhase, LobbyRoom } from '@nine-cards/shared';

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
// 一局結束到自動開下一局的間隔（讓玩家看結算；可用 NEXT_HAND_MS 覆寫）
const NEXT_HAND_MS = Number(process.env.NEXT_HAND_MS ?? 6000);

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
  scores: Map<string, number>; // playerId → 本場累計頭數（跨局保留）
  settled: boolean; // 本局結算是否已套用（避免重複計分）
  claimTimer?: ReturnType<typeof setTimeout>;
  scheduledClaimId?: number;
  nextHandTimer?: ReturnType<typeof setTimeout>; // 續局計時器（§4.2/§12）
  dealerRevealTimer?: ReturnType<typeof setTimeout>; // 決定莊家展示計時器（§4.1）
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
      scores: new Map(),
      settled: false,
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
    // 本場累計頭數歸零（每位玩家）
    room.scores = new Map(room.players.map((p) => [p.id, 0]));
    // §4.1：第一局由玩家自己抽牌決定莊家（引擎進入 DEAL_DRAW，莊家決定後才發牌）
    room.engine = new GameEngine(seats, null);
    room.lastDealerSeat = 0; // 佔位，莊家決定後於 action() 同步為實際莊家
    room.settled = false;
    room.phase = 'PLAYING';
    this.syncScores(room);
    this.scheduleClaim(room);
    return { ok: true, room };
  }

  // 把 room.scores 的跨局累計同步進引擎玩家，讓 viewFor 帶出目前總分
  private syncScores(room: Room) {
    if (!room.engine) return;
    for (const ep of room.engine.players) {
      ep.score = room.scores.get(ep.id) ?? 0;
    }
  }

  // 一局結束：套用本局頭數變化到跨局累計，並補齊 roundResult 的 scores/nextDealerSeat
  private settleRound(room: Room) {
    const rr = room.engine?.roundResult;
    if (!rr || room.settled) return;
    room.settled = true;
    for (const pay of rr.payments) {
      const pl = room.players[pay.seat];
      if (pl) room.scores.set(pl.id, (room.scores.get(pl.id) ?? 0) + pay.delta);
    }
    // 流局：原莊連任（§4.2）；胡牌：胡牌者當莊（引擎已設）
    if (rr.reason === 'draw') rr.nextDealerSeat = room.lastDealerSeat;
    rr.scores = room.players.map((p) => ({ seat: p.seat, total: room.scores.get(p.id) ?? 0 }));
    this.syncScores(room);
    this.scheduleNextHand(room); // 一段時間後自動開下一局（§4.2/§12）
  }

  // 排定續局計時器
  private scheduleNextHand(room: Room) {
    if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
    room.nextHandTimer = setTimeout(() => this.startNextHand(room), NEXT_HAND_MS);
  }

  // 開下一局：沿用累計分數，莊家為上一局結算指定者（胡牌者／流局原莊，§4.2）
  private startNextHand(room: Room) {
    room.nextHandTimer = undefined;
    if (!this.rooms.has(room.id) || room.phase !== 'FINISHED' || !room.engine) return;
    const connected = room.players.filter((p) => p.connected).length;
    if (connected === 0) return; // 全離線，停止續局
    if (connected < MIN_PLAYERS) return this.scheduleNextHand(room); // 人數不足，稍後再試

    const prev = room.engine.roundResult;
    const dealerSeat =
      prev && prev.nextDealerSeat != null ? prev.nextDealerSeat : room.lastDealerSeat;
    room.lastDealerSeat = dealerSeat;
    const seats: SeatInit[] = room.players.map((p) => ({ id: p.id, name: p.name }));
    room.engine = new GameEngine(seats, dealerSeat);
    room.settled = false;
    this.syncScores(room);
    if (room.engine.phase === 'FINISHED') {
      // 連續天胡：直接結算（會再排下一局）
      room.phase = 'FINISHED';
      this.settleRound(room);
    } else {
      room.phase = 'PLAYING';
      room.engine.message = `${seats[dealerSeat].name} 當莊，開局（莊家先打）`;
    }
    this.scheduleClaim(room);
    this.broadcast?.(room);
  }

  action(playerId: string, type: ActionType, cardId?: string): ActionResult {
    const room = this.findRoomByPlayer(playerId);
    if (!room || !room.engine) return { ok: false, error: '目前沒有進行中的牌局' };
    const res = room.engine.apply(playerId, type, cardId);
    if (!res.ok) return { ok: false, error: res.error, room };
    // 莊家一經決定（§4.1）即同步為續局／流局連任的依據
    if (room.engine.dealerSeat != null) room.lastDealerSeat = room.engine.dealerSeat;
    if (room.engine.phase === 'FINISHED' && room.phase !== 'FINISHED') {
      room.phase = 'FINISHED';
      this.settleRound(room);
    }
    this.scheduleClaim(room);
    this.scheduleDealerReveal(room);
    return { ok: true, room };
  }

  // 決定莊家後排一個展示計時器：時間到才發牌並開局（§4.1），讓玩家先看清抽到的牌
  private scheduleDealerReveal(room: Room) {
    const eng = room.engine;
    if (!eng || eng.stage !== 'DEAL_DRAW' || !eng.dealerDecided) return;
    if (room.dealerRevealTimer) return; // 已排程
    const delay = Math.max(0, eng.dealerRevealEndsAt - Date.now());
    room.dealerRevealTimer = setTimeout(() => {
      room.dealerRevealTimer = undefined;
      const r = this.rooms.get(room.id);
      if (!r || !r.engine) return;
      r.engine.finalizeDealerDraw(); // 發牌開局（天胡則直接結算）
      if (r.engine.dealerSeat != null) r.lastDealerSeat = r.engine.dealerSeat;
      if (r.engine.phase === 'FINISHED' && r.phase !== 'FINISHED') {
        r.phase = 'FINISHED';
        this.settleRound(r);
      }
      this.scheduleClaim(r);
      this.broadcast?.(r);
    }, delay + 30);
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

  // 玩家按下離台（§13：整場遊戲結束）：停止續局，全離線則回收房間
  leaveRoom(playerId: string): Room | undefined {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return undefined;
    const p = room.players.find((x) => x.id === playerId);
    if (p) {
      p.connected = false;
      p.socketId = null;
      this.tokenIndex.delete(p.token);
      room.engine?.setConnected(playerId, false);
    }
    if (room.nextHandTimer) {
      clearTimeout(room.nextHandTimer); // 有人離台 → 停止續局
      room.nextHandTimer = undefined;
    }
    if (room.players.every((x) => !x.connected)) {
      this.disposeRoom(room);
      return undefined;
    }
    return room;
  }

  private disposeRoom(room: Room) {
    if (room.claimTimer) clearTimeout(room.claimTimer);
    if (room.nextHandTimer) clearTimeout(room.nextHandTimer);
    if (room.dealerRevealTimer) clearTimeout(room.dealerRevealTimer);
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
