// 房間、配對與玩家身分管理（不直接碰 socket，交由 index.ts 廣播）
import { randomUUID } from 'node:crypto';
import { GameEngine, type SeatInit } from './engine.js';
import type { ActionType, RoomView, RoomPhase, LobbyRoom, GameEndedPayload } from '@nine-cards/shared';

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
  scores: Map<string, number>; // playerId → 本場累計頭數（跨局保留）
  settled: boolean; // 本局結算是否已套用（避免重複計分）
  readyIds: Set<string>; // 結算後已按「繼續」的 playerId（全員按下才開下一局，§13）
  claimTimer?: ReturnType<typeof setTimeout>;
  scheduledClaimId?: number;
  dealerRevealTimer?: ReturnType<typeof setTimeout>; // 決定莊家展示計時器（§4.1）
  paused: boolean; // 有玩家斷線 → 全體暫停等待重連（凍結計時器、擋動作）
  pausedAt?: number; // 進入暫停的時間點，重連時據以把凍結的計時器整體後移
  endResult?: GameEndedPayload; // 整場結束（有人離開）的最終計分版（ENDED 階段）
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
      readyIds: new Set(),
      paused: false,
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
    // 全員回到線上 → 解除暫停，並把暫停期間凍結的計時器整體後移，繼續牌局
    if (room.paused && room.players.every((p) => p.connected)) this.resumeRoom(room);
    return { ok: true, room, player };
  }

  // 所有玩家皆回到線上：解除暫停。把吃牌窗／莊家展示的截止時間整體往後推「暫停時長」，
  // 再重排計時器，讓玩家有原本完整的反應時間。
  private resumeRoom(room: Room) {
    const elapsed = Date.now() - (room.pausedAt ?? Date.now());
    const eng = room.engine;
    if (eng) {
      // 自摸保護為不限時（MAX_SAFE_INTEGER），不要位移
      if (eng.claimEndsAt > 0 && eng.claimEndsAt < Number.MAX_SAFE_INTEGER) eng.claimEndsAt += elapsed;
      if (eng.dealerRevealEndsAt > 0) eng.dealerRevealEndsAt += elapsed;
    }
    room.paused = false;
    room.pausedAt = undefined;
    this.scheduleClaim(room);
    this.scheduleDealerReveal(room);
  }

  // 有玩家斷線 → 全體暫停：凍結會自動推進狀態的計時器，等重連後再排
  private pauseRoom(room: Room) {
    if (room.paused) return;
    room.paused = true;
    room.pausedAt = Date.now();
    if (room.claimTimer) clearTimeout(room.claimTimer);
    room.claimTimer = undefined;
    room.scheduledClaimId = undefined; // 讓 resumeRoom 能重新排這個吃牌窗
    if (room.dealerRevealTimer) clearTimeout(room.dealerRevealTimer);
    room.dealerRevealTimer = undefined;
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
    room.readyIds = new Set(); // 結算後等待全員按「繼續」才開下一局（§13）
  }

  // 玩家於結算畫面按「繼續」：全員（在線者）都按下才開下一局
  readyContinue(playerId: string): ActionResult {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return { ok: false, error: '不在任何房間' };
    if (room.phase !== 'FINISHED') return { ok: false, error: '目前無法繼續' };
    if (room.paused) return { ok: false, error: '有玩家斷線，遊戲暫停中', room };
    room.readyIds.add(playerId);
    this.maybeStartNextHand(room);
    return { ok: true, room };
  }

  // 在線玩家是否都已按「繼續」（且人數足夠）
  private allReady(room: Room): boolean {
    const connected = room.players.filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) return false;
    return connected.every((p) => room.readyIds.has(p.id));
  }

  // 條件成立就開下一局；否則維持結算畫面
  private maybeStartNextHand(room: Room) {
    if (room.phase === 'FINISHED' && this.allReady(room)) this.startNextHand(room);
  }

  // 開下一局：沿用累計分數，莊家為上一局結算指定者（胡牌者／流局原莊，§4.2）
  private startNextHand(room: Room) {
    if (!this.rooms.has(room.id) || room.phase !== 'FINISHED' || !room.engine) return;
    room.readyIds = new Set(); // 開新局，清空繼續狀態

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
    if (room.paused) return { ok: false, error: '有玩家斷線，遊戲暫停中', room };
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
    if (room.paused) return; // 暫停中不推進狀態（重連後由 resumeRoom 重排）
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
    if (room.paused) return; // 暫停中不排吃牌窗計時器（重連後由 resumeRoom 重排）
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
      // 整桌都離線 → 沒有人可等待重連，直接回收房間（含未開局的等待房）
      if (room.players.every((p) => !p.connected)) {
        this.disposeRoom(room);
        return undefined;
      }
      // 對局進行中（含單局結算）意外斷線 → 全體暫停，等待該玩家重連
      if (room.phase === 'PLAYING' || room.phase === 'FINISHED') this.pauseRoom(room);
      return room;
    }
    return undefined;
  }

  // 玩家按下離開遊戲：對局進行中 → 整場結束、顯示最終計分版給其餘玩家；
  // 等待中／已結束 → 移除該玩家，全空則回收房間。
  leaveRoom(playerId: string): Room | undefined {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return undefined;
    const p = room.players.find((x) => x.id === playerId);
    if (p) {
      p.connected = false;
      p.socketId = null;
      this.tokenIndex.delete(p.token);
      room.readyIds.delete(p.id);
      room.engine?.setConnected(playerId, false);
    }

    // 對局進行中（含單局結算）有人離開 → 結束整場，準備最終計分版
    if (room.phase === 'PLAYING' || room.phase === 'FINISHED') {
      this.endGame(room, p?.name ?? '玩家');
      // 觸發者仍是全員離線的話直接回收（例如兩人房另一人已斷線）
      if (room.players.every((x) => !x.connected)) {
        this.disposeRoom(room);
        return undefined;
      }
      return room;
    }

    // 等待中或已結束：全空則回收房間
    if (room.players.every((x) => !x.connected)) {
      this.disposeRoom(room);
      return undefined;
    }
    return room;
  }

  // 結束整場：凍結計時器、切到 ENDED，組出最終計分版（各家跨局累計頭數）
  private endGame(room: Room, leaverName: string) {
    if (room.phase === 'ENDED') return;
    if (room.claimTimer) clearTimeout(room.claimTimer);
    if (room.dealerRevealTimer) clearTimeout(room.dealerRevealTimer);
    room.claimTimer = undefined;
    room.dealerRevealTimer = undefined;
    room.scheduledClaimId = undefined;
    room.paused = false;
    room.phase = 'ENDED';
    room.endResult = {
      reason: 'playerLeft',
      leaverName,
      scores: room.players
        .map((pl) => ({ seat: pl.seat, name: pl.name, total: room.scores.get(pl.id) ?? 0 }))
        .sort((a, b) => b.total - a.total),
    };
  }

  private disposeRoom(room: Room) {
    if (room.claimTimer) clearTimeout(room.claimTimer);
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
