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

// 依房間階段，把最新狀態推送給每位「連線中的」玩家
function pushState(room: Room) {
  if (room.phase === 'WAITING') {
    const view = game.roomView(room);
    for (const p of room.players) {
      if (p.connected && p.socketId) io.to(p.socketId).emit(EVT.ROOM_UPDATE, view);
    }
    return;
  }
  // PLAYING / FINISHED → 個人化視圖（隱藏他人手牌）
  const engine = room.engine!;
  for (const p of room.players) {
    if (!p.connected || !p.socketId) continue;
    const state = engine.viewFor(p.id);
    state.roomId = room.id;
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
    const r = game.createRoom(req?.name ?? '玩家', socket.id, req?.isPublic ?? false);
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
    pushState(r.room);
    broadcastLobby();
  });

  socket.on(EVT.QUICK_MATCH, (req: QuickMatchReq, ack?: (r: JoinResult) => void) => {
    const r = game.quickMatch(req?.name ?? '玩家', socket.id);
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    socket.leave('lobby');
    respond(ack, joinResult(r.room, r.player));
    pushState(r.room);
    broadcastLobby();
  });

  socket.on(EVT.RESUME, (req: ResumeReq, ack?: (r: JoinResult) => void) => {
    const r = game.resume(req?.token ?? '', socket.id);
    if (!r.ok || !r.room || !r.player) return respond(ack, { ok: false, error: r.error });
    respond(ack, joinResult(r.room, r.player));
    pushState(r.room);
  });

  socket.on(EVT.START_GAME, (playerId: string) => {
    const r = game.startGame(playerId);
    if (!r.ok) return emitError(socket.id, r.error);
    if (r.room) pushState(r.room);
    broadcastLobby(); // 開局後房間離開等待狀態，從大廳移除
  });

  socket.on(EVT.ACTION, (playerId: string, req: ActionReq) => {
    const r = game.action(playerId, req?.type, req?.cardId);
    if (!r.ok) emitError(socket.id, r.error);
    if (r.room) pushState(r.room);
  });

  socket.on(EVT.LEAVE, (playerId: string) => {
    const room = game.leaveRoom(playerId);
    if (room) pushState(room);
    broadcastLobby();
  });

  socket.on('disconnect', () => {
    const room = game.markDisconnected(socket.id);
    if (room) pushState(room);
    broadcastLobby(); // 公開房人數/存在可能改變
  });
});

function joinResult(room: Room, player: { id: string; token: string }): JoinResult {
  return { ok: true, roomId: room.id, code: room.code, playerId: player.id, token: player.token };
}

function emitError(socketId: string, message?: string) {
  io.to(socketId).emit(EVT.ERROR_MSG, { message: message ?? '發生錯誤' });
}

httpServer.listen(PORT, () => {
  console.log(`九支仔 server listening on http://localhost:${PORT}`);
});
