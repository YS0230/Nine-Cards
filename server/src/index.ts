import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { GameServer, type Room } from './game/gameServer.js';
import {
  EVT,
  type CreateRoomReq,
  type JoinRoomReq,
  type QuickMatchReq,
  type ResumeReq,
  type ActionReq,
  type JoinResult,
  type ChatReq,
  type ChatMessage,
} from '@nine-cards/shared';

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

const game = new GameServer();

app.get('/health', (_req, res) => res.json({ ok: true }));

// 正式部署(單一 service)：server 直接供應 client build 出來的靜態檔案
const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io') || req.path === '/health') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// 把最新公開大廳清單推給所有在「大廳」的連線
function broadcastLobby() {
  io.to('lobby').emit(EVT.LOBBY_UPDATE, game.publicLobby());
}

// 把一則聊天訊息推給房內每位在線玩家
function broadcastChat(room: Room, msg: ChatMessage) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit(EVT.CHAT_MSG, msg);
  }
}

// 依房間階段，把最新狀態推送給每位「連線中的」玩家
function pushState(room: Room) {
  if (room.phase === 'WAITING') {
    const view = game.roomView(room);
    for (const p of room.players) {
      if (p.connected && p.socketId) io.to(p.socketId).emit(EVT.ROOM_UPDATE, view);
    }
    return;
  }
  // ENDED → 整場結束，推最終計分版給每位在線玩家
  if (room.phase === 'ENDED' && room.endResult) {
    for (const p of room.players) {
      if (p.connected && p.socketId) io.to(p.socketId).emit(EVT.GAME_ENDED, room.endResult);
    }
    return;
  }
  // PLAYING / FINISHED → 個人化視圖（隱藏他人手牌）
  const engine = room.engine!;
  // 結算後已按「繼續」的座位（§13）；engine 不知房間 readyIds，於此補上
  const readySeats = room.players.filter((p) => room.readyIds.has(p.id)).map((p) => p.seat);
  // 暫停遮罩：斷線中的玩家名稱（其餘在線者據以顯示等待重連遮罩）
  const disconnectedNames = room.players.filter((p) => !p.connected).map((p) => p.name);
  for (const p of room.players) {
    if (!p.connected || !p.socketId) continue;
    const state = engine.viewFor(p.id);
    state.roomId = room.id;
    state.continueReady = readySeats;
    state.paused = room.paused;
    state.disconnectedNames = disconnectedNames;
    io.to(p.socketId).emit(EVT.GAME_STATE, state);
  }
  if (room.phase === 'FINISHED' && engine.roundResult) {
    for (const p of room.players) {
      if (p.connected && p.socketId) {
        io.to(p.socketId).emit(EVT.GAME_OVER, engine.roundResult);
      }
    }
  }
}

// 時間窗到時自動結算後，也要把新狀態推播給房內玩家
game.setBroadcaster((room) => pushState(room));

io.on('connection', (socket) => {
  const respond = (ack: ((r: JoinResult) => void) | undefined, outcome: JoinResult) => {
    if (typeof ack === 'function') ack(outcome);
  };

  socket.on(EVT.WATCH_LOBBY, () => {
    socket.join('lobby');
    socket.emit(EVT.LOBBY_UPDATE, game.publicLobby());
  });
  socket.on(EVT.UNWATCH_LOBBY, () => socket.leave('lobby'));

  socket.on(EVT.CREATE_ROOM, (req: CreateRoomReq, ack?: (r: JoinResult) => void) => {
    const r = game.createRoom(
      req?.name ?? '玩家',
      socket.id,
      req?.isPublic ?? false,
      req?.hints ?? true,
      req?.claimSeconds,
      req?.startingCapital,
      req?.unitBet,
    );
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    socket.leave('lobby');
    respond(ack, joinResult(r.room, r.player));
    pushState(r.room);
    broadcastLobby();
  });

  socket.on(EVT.JOIN_ROOM, (req: JoinRoomReq, ack?: (r: JoinResult) => void) => {
    const r = game.joinByCode(req?.code ?? '', req?.name ?? '玩家', socket.id);
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    socket.leave('lobby');
    respond(ack, joinResult(r.room, r.player));
    sendChatHistory(socket.id, r.room);
    pushState(r.room);
    broadcastLobby();
  });

  socket.on(EVT.QUICK_MATCH, (req: QuickMatchReq, ack?: (r: JoinResult) => void) => {
    const r = game.quickMatch(req?.name ?? '玩家', socket.id);
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    socket.leave('lobby');
    respond(ack, joinResult(r.room, r.player));
    sendChatHistory(socket.id, r.room);
    pushState(r.room);
    broadcastLobby();
  });

  socket.on(EVT.RESUME, (req: ResumeReq, ack?: (r: JoinResult) => void) => {
    const r = game.resume(req?.token ?? '', socket.id);
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    respond(ack, joinResult(r.room, r.player));
    sendChatHistory(socket.id, r.room);
    pushState(r.room);
  });

  socket.on(EVT.START_GAME, (playerId: string) => {
    const r = game.startGame(playerId);
    if (!r.ok) return emitError(socket.id, r.error);
    if (r.room) pushState(r.room);
    broadcastLobby(); // 開局後房間改標記為遊戲中（大廳仍顯示但不可加入）
  });

  socket.on(EVT.ACTION, (playerId: string, req: ActionReq) => {
    const r = game.action(playerId, req?.type, req?.cardId);
    if (!r.ok) emitError(socket.id, r.error);
    if (r.room) pushState(r.room);
  });

  socket.on(EVT.CONTINUE, (playerId: string) => {
    const r = game.readyContinue(playerId);
    if (!r.ok) emitError(socket.id, r.error);
    if (r.room) pushState(r.room);
  });

  socket.on(EVT.LEAVE, (playerId: string) => {
    const room = game.leaveRoom(playerId);
    if (room) pushState(room);
    broadcastLobby();
  });

  socket.on(EVT.SEND_CHAT, (playerId: string, req: ChatReq) => {
    const r = game.chat(playerId, req?.text ?? '');
    if (!r.ok) return emitError(socket.id, r.error);
    if (r.room && r.msg) broadcastChat(r.room, r.msg);
  });

  socket.on('disconnect', () => {
    for (const room of game.markDisconnected(socket.id)) pushState(room);
    broadcastLobby(); // 公開房人數/存在可能改變
  });
});

function joinResult(room: Room, player: { id: string; token: string }): JoinResult {
  return { ok: true, roomId: room.id, code: room.code, playerId: player.id, token: player.token };
}

function emitError(socketId: string, message?: string) {
  io.to(socketId).emit(EVT.ERROR_MSG, { message: message ?? '發生錯誤' });
}

// 加入／重連成功後補發整段聊天記錄，讓中途加入者也看得到之前的訊息
function sendChatHistory(socketId: string, room: Room) {
  if (room.chatLog.length) io.to(socketId).emit(EVT.CHAT_HISTORY, room.chatLog);
}

httpServer.listen(PORT, () => {
  console.log(`九支仔 server listening on http://localhost:${PORT}`);
});
