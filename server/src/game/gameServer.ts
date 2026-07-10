// 房間、配對與玩家身分管理（不直接碰 socket，交由 index.ts 廣播）
import { randomUUID } from 'node:crypto';
import { CLAIM_WINDOW_MS, GameEngine, type SeatInit } from './engine.js';
import type {
  ActionType,
  RoomView,
  RoomPhase,
  LobbyRoom,
  GameEndedPayload,
  ChatMessage,
} from '@nine-cards/shared';

// 房間人數上限為建房選項（2–8）：牌共 112 張、發牌 9k+1、流局底留 9 張，
// 8 人局仍有約 30 張可摸；超過 8 人牌堆過薄，遊戲節奏不成立
const DEFAULT_MAX_PLAYERS = 4;
const MAX_PLAYERS_LIMIT = 8;
const MIN_PLAYERS = 2;
const DEFAULT_STARTING_CAPITAL = 2000; // 本金預設值（元）
const DEFAULT_UNIT_BET = 50; // 一頭預設值（元）
const CHAT_LOG_MAX = 50; // 聊天記錄保留則數上限
const CHAT_TEXT_MAX = 100; // 單則聊天訊息字數上限
const CHAT_COOLDOWN_MS = 500; // 兩次發言最短間隔（防洗頻）
// 全員離線後房間的保留寬限時間：手機切換 APP／鎖屏造成的短暫斷線，可在此時間內重連回來
const EMPTY_ROOM_GRACE_MS = Number(process.env.EMPTY_ROOM_GRACE_MS ?? 120_000);

export interface Player {
  id: string;
  name: string;
  token: string; // 重連用秘鑰
  seat: number; // 座位索引（開局後 0..k-1）
  socketId: string | null;
  connected: boolean;
  lastChatAt?: number; // 上次發言時間（防洗頻）
}

export interface Room {
  id: string;
  code: string;
  isPublic: boolean;
  hints: boolean; // 新手提示（建房時選擇）：開＝伺服器預檢吃/胡、前端鎖定按鈕
  claimMs: number; // 吃牌窗等待毫秒（建房時選擇秒數）
  maxPlayers: number; // 房間人數上限（建房時選擇，2–8）
  startingCapital: number; // 本金：每位玩家初始金額（建房時選擇）
  unitBet: number; // 一頭金額：頭數換算成錢的單價（建房時選擇）
  phase: RoomPhase;
  players: Player[]; // 依加入順序，開局後 seat 對齊索引
  hostId: string | null;
  engine: GameEngine | null;
  lastDealerSeat: number;
  scores: Map<string, number>; // playerId → 本場累計頭數（跨局保留）
  money: Map<string, number>; // playerId → 剩餘金額（本金 + 頭數 × 一頭，跨局保留）
  settled: boolean; // 本局結算是否已套用（避免重複計分）
  readyIds: Set<string>; // 結算後已按「繼續」的 playerId（全員按下才開下一局，§13）
  claimTimer?: ReturnType<typeof setTimeout>;
  scheduledClaimId?: number;
  dealerRevealTimer?: ReturnType<typeof setTimeout>; // 決定莊家展示計時器（§4.1）
  disposeTimer?: ReturnType<typeof setTimeout>; // 全員離線後的回收寬限計時器
  paused: boolean; // 有玩家斷線 → 全體暫停等待重連（凍結計時器、擋動作）
  pausedAt?: number; // 進入暫停的時間點，重連時據以把凍結的計時器整體後移
  endResult?: GameEndedPayload; // 整場結束（有人離開）的最終計分版（ENDED 階段）
  chatLog: ChatMessage[]; // 房間聊天記錄（保留最近 CHAT_LOG_MAX 則，房間回收即消失）
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

  // 房間內聊天：驗證後寫入 chatLog，訊息本體交由 index.ts 廣播（本類不碰 socket）
  chat(playerId: string, text: string): { ok: boolean; error?: string; room?: Room; msg?: ChatMessage } {
    const room = this.findRoomByPlayer(playerId);
    const player = room?.players.find((p) => p.id === playerId);
    if (!room || !player) return { ok: false, error: '你不在任何房間中' };
    const trimmed = String(text ?? '').trim().slice(0, CHAT_TEXT_MAX);
    if (!trimmed) return { ok: false, error: '訊息不能是空白' };
    const now = Date.now();
    if (player.lastChatAt != null && now - player.lastChatAt < CHAT_COOLDOWN_MS) {
      return { ok: false, error: '說話太快了，稍等一下' };
    }
    player.lastChatAt = now;
    const msg: ChatMessage = {
      playerId: player.id,
      name: player.name,
      seat: player.seat,
      text: trimmed,
      ts: now,
    };
    room.chatLog.push(msg);
    if (room.chatLog.length > CHAT_LOG_MAX) room.chatLog.shift();
    return { ok: true, room, msg };
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

  createRoom(
    name: string,
    socketId: string,
    isPublic = false,
    hints = true,
    claimSeconds?: number,
    startingCapital?: number,
    unitBet?: number,
    maxPlayers?: number,
  ): JoinOutcome {
    this.detachSocket(socketId); // 先清掉同連線的舊身分，避免殘留幽靈玩家
    const id = randomUUID();
    const code = makeCode(new Set(this.codeIndex.keys()));
    const host = this.newPlayer(name, socketId, 0);
    // 吃牌窗秒數（建房選項）：限制 1–30 秒，非法值回落預設
    const secs = Number(claimSeconds);
    const claimMs =
      Number.isFinite(secs) && secs >= 1 && secs <= 30 ? Math.round(secs * 1000) : CLAIM_WINDOW_MS;
    // 本金／一頭（建房選項）：需為正整數，非法值回落預設
    const capital = Number(startingCapital);
    const cap = Number.isFinite(capital) && capital > 0 ? Math.round(capital) : DEFAULT_STARTING_CAPITAL;
    const bet = Number(unitBet);
    const unit = Number.isFinite(bet) && bet > 0 ? Math.round(bet) : DEFAULT_UNIT_BET;
    // 人數上限（建房選項）：限制 2–8，非法值回落預設
    const mp = Number(maxPlayers);
    const max =
      Number.isFinite(mp) && mp >= MIN_PLAYERS && mp <= MAX_PLAYERS_LIMIT
        ? Math.round(mp)
        : DEFAULT_MAX_PLAYERS;
    const room: Room = {
      id,
      code,
      isPublic,
      hints,
      claimMs,
      maxPlayers: max,
      startingCapital: cap,
      unitBet: unit,
      phase: 'WAITING',
      players: [host],
      hostId: host.id,
      engine: null,
      lastDealerSeat: 0,
      scores: new Map(),
      money: new Map(),
      settled: false,
      readyIds: new Set(),
      paused: false,
      chatLog: [],
    };
    this.rooms.set(id, room);
    this.codeIndex.set(code, id);
    this.tokenIndex.set(host.token, { roomId: id, playerId: host.id });
    return { ok: true, room, player: host };
  }

  joinByCode(code: string, name: string, socketId: string): JoinOutcome {
    const roomId = this.codeIndex.get(code.toUpperCase().trim());
    if (!roomId) return { ok: false, error: '找不到這個房號' };
    this.detachSocket(socketId); // 先清掉同連線的舊身分，避免殘留幽靈玩家
    return this.joinRoom(roomId, name, socketId);
  }

  private joinRoom(roomId: string, name: string, socketId: string): JoinOutcome {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房間不存在' };
    if (room.phase !== 'WAITING') return { ok: false, error: '牌局已開始，無法加入' };
    if (room.players.length >= room.maxPlayers) return { ok: false, error: '房間已滿' };
    const player = this.newPlayer(name, socketId, room.players.length);
    room.players.push(player);
    this.tokenIndex.set(player.token, { roomId: room.id, playerId: player.id });
    return { ok: true, room, player };
  }

  quickMatch(name: string, socketId: string): JoinOutcome {
    this.detachSocket(socketId); // 先清掉同連線的舊身分，避免殘留幽靈玩家
    // 找一個公開、等待中、有空位、還有人在線的房間；沒有就開一個公開房
    for (const room of this.rooms.values()) {
      if (
        room.isPublic &&
        room.phase === 'WAITING' &&
        room.players.length < room.maxPlayers &&
        room.players.some((p) => p.connected)
      ) {
        return this.joinRoom(room.id, name, socketId);
      }
    }
    return this.createRoom(name, socketId, true);
  }

  // 同一條連線若在其他房間仍有身分（例如斷線恢復後的舊畫面又按了建房/加入）→ 視同離開該房，
  // 否則會留下永遠顯示「在線」的幽靈玩家，讓房間無法被回收
  private detachSocket(socketId: string) {
    for (const room of [...this.rooms.values()]) {
      const p = room.players.find((x) => x.socketId === socketId);
      if (!p) continue;
      const r = this.leaveRoom(p.id);
      if (r) this.broadcast?.(r);
    }
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
    // 有人回來了 → 取消全員離線的回收寬限計時器
    if (room.disposeTimer) {
      clearTimeout(room.disposeTimer);
      room.disposeTimer = undefined;
    }
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
    // 本場累計頭數歸零、金額回到本金（每位玩家）
    room.scores = new Map(room.players.map((p) => [p.id, 0]));
    room.money = new Map(room.players.map((p) => [p.id, room.startingCapital]));
    // §4.1：第一局由玩家自己抽牌決定莊家（引擎進入 DEAL_DRAW，莊家決定後才發牌）
    room.engine = new GameEngine(seats, null, undefined, {
      hints: room.hints,
      claimWindowMs: room.claimMs,
    });
    room.lastDealerSeat = 0; // 佔位，莊家決定後於 action() 同步為實際莊家
    room.settled = false;
    room.phase = 'PLAYING';
    this.syncScores(room);
    this.syncMoney(room);
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

  // 把 room.money 的跨局累計同步進引擎玩家，讓 viewFor 帶出目前剩餘金額
  private syncMoney(room: Room) {
    if (!room.engine) return;
    for (const ep of room.engine.players) {
      ep.money = room.money.get(ep.id) ?? room.startingCapital;
    }
  }

  // 一局結束：套用本局頭數變化到跨局累計（金額＝頭數 × 一頭），並補齊 roundResult 的 scores/nextDealerSeat
  private settleRound(room: Room) {
    const rr = room.engine?.roundResult;
    if (!rr || room.settled) return;
    room.settled = true;
    for (const pay of rr.payments) {
      const pl = room.players[pay.seat];
      if (!pl) continue;
      room.scores.set(pl.id, (room.scores.get(pl.id) ?? 0) + pay.delta);
      room.money.set(pl.id, (room.money.get(pl.id) ?? room.startingCapital) + pay.delta * room.unitBet);
    }
    // 流局：原莊連任（§4.2）；胡牌：胡牌者當莊（引擎已設）
    if (rr.reason === 'draw') rr.nextDealerSeat = room.lastDealerSeat;
    rr.scores = room.players.map((p) => ({ seat: p.seat, total: room.scores.get(p.id) ?? 0 }));
    this.syncScores(room);
    this.syncMoney(room);
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
    room.engine = new GameEngine(seats, dealerSeat, undefined, {
      hints: room.hints,
      claimWindowMs: room.claimMs,
    });
    room.settled = false;
    this.syncScores(room);
    this.syncMoney(room);
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

  markDisconnected(socketId: string): Room[] {
    // 同一條連線可能在多個房間留有身分，必須全部處理（漏掉會留下永遠「在線」的幽靈玩家）
    const affected: Room[] = [];
    for (const room of this.rooms.values()) {
      const player = room.players.find((p) => p.socketId === socketId);
      if (!player) continue;
      player.connected = false;
      player.socketId = null;
      room.engine?.setConnected(player.id, false);
      // 對局進行中（含單局結算）意外斷線 → 全體暫停，等待該玩家重連
      if (room.phase === 'PLAYING' || room.phase === 'FINISHED') this.pauseRoom(room);
      // 整桌都離線 → 不立即回收：手機切換 APP／鎖屏常造成短暫斷線，保留寬限時間等人回來
      if (room.players.every((p) => !p.connected)) this.scheduleDispose(room);
      affected.push(room);
    }
    return affected;
  }

  // 全員離線：排一個寬限計時器，時間到仍無人重連才真正回收房間
  private scheduleDispose(room: Room) {
    if (room.disposeTimer) return;
    room.disposeTimer = setTimeout(() => {
      room.disposeTimer = undefined;
      const r = this.rooms.get(room.id);
      if (r && r.players.every((p) => !p.connected)) this.disposeRoom(r);
    }, EMPTY_ROOM_GRACE_MS);
  }

  // 玩家按下離開遊戲：對局進行中（含單局結算）→ 整場結束、顯示最終計分版給其餘玩家
  // （座位仍對應引擎座位，不可移除，只標記斷線）；
  // 等待中／已結束 → 真正移除該玩家、釋出座位，房主離開則交棒給下一位，全空才回收房間。
  leaveRoom(playerId: string): Room | undefined {
    const room = this.findRoomByPlayer(playerId);
    if (!room) return undefined;
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return room;
    this.tokenIndex.delete(p.token);
    room.readyIds.delete(p.id);

    // 對局進行中（含單局結算）有人離開 → 結束整場，準備最終計分版
    if (room.phase === 'PLAYING' || room.phase === 'FINISHED') {
      p.connected = false;
      p.socketId = null;
      room.engine?.setConnected(playerId, false);
      this.endGame(room, p.name);
      // 觸發者仍是全員離線的話直接回收（例如兩人房另一人已斷線）
      if (room.players.every((x) => !x.connected)) {
        this.disposeRoom(room);
        return undefined;
      }
      return room;
    }

    // 等待中／已結束：直接移出玩家清單（而非僅標記斷線），座位不再佔用
    room.players = room.players.filter((x) => x.id !== playerId);
    if (room.players.length === 0) {
      this.disposeRoom(room);
      return undefined;
    }
    room.players.forEach((pl, i) => (pl.seat = i)); // 座位壓實，供 roomView／下一位加入對齊
    if (room.hostId === playerId) room.hostId = room.players[0].id; // 房主離開 → 交棒
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
        .map((pl) => ({
          seat: pl.seat,
          name: pl.name,
          total: room.scores.get(pl.id) ?? 0,
          money: room.money.get(pl.id) ?? room.startingCapital,
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  private disposeRoom(room: Room) {
    if (room.claimTimer) clearTimeout(room.claimTimer);
    if (room.dealerRevealTimer) clearTimeout(room.dealerRevealTimer);
    if (room.disposeTimer) clearTimeout(room.disposeTimer);
    this.rooms.delete(room.id);
    this.codeIndex.delete(room.code);
    for (const p of room.players) this.tokenIndex.delete(p.token);
  }

  // 公開大廳：所有公開、還有人在線的房間摘要。等待中且有空位的可加入；
  // 已開局（遊戲中／結算中）的也列出但標記 inGame，僅供觀看不可加入。
  // （全員離線的房間在回收寬限期內仍可用房號連結加入，但不顯示在大廳）
  publicLobby(): LobbyRoom[] {
    const list: LobbyRoom[] = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic || !room.players.some((p) => p.connected)) continue;
      const waiting = room.phase === 'WAITING';
      if (waiting && room.players.length >= room.maxPlayers) continue;
      if (!waiting && room.phase !== 'PLAYING' && room.phase !== 'FINISHED') continue;
      list.push({
        code: room.code,
        hostName: room.players.find((p) => p.id === room.hostId)?.name ?? '房主',
        count: room.players.length,
        maxPlayers: room.maxPlayers,
        inGame: !waiting,
      });
    }
    return list;
  }

  roomView(room: Room): RoomView {
    const seats = Array.from({ length: room.maxPlayers }, (_, i) => {
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
      hints: room.hints,
      claimSeconds: Math.round(room.claimMs / 1000),
      startingCapital: room.startingCapital,
      unitBet: room.unitBet,
      seats,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
    };
  }
}
