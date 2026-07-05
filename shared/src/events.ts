import type { ActionType, PersonalGameState, RoomView, GameOverPayload } from './types.js';

// Socket.IO 事件名稱（前後端共用常數，避免打錯字）
export const EVT = {
  // Client → Server
  CREATE_ROOM: 'createRoom',
  JOIN_ROOM: 'joinRoom',
  QUICK_MATCH: 'quickMatch',
  RESUME: 'resume',
  START_GAME: 'startGame',
  ACTION: 'action',
  LEAVE: 'leave',
  WATCH_LOBBY: 'watchLobby',
  UNWATCH_LOBBY: 'unwatchLobby',
  // Server → Client
  ROOM_UPDATE: 'roomUpdate',
  GAME_STATE: 'gameState',
  GAME_OVER: 'gameOver',
  ERROR_MSG: 'errorMsg',
  LOBBY_UPDATE: 'lobbyUpdate',
} as const;

// ── Client → Server payloads ─────────────────────────────
export interface JoinResult {
  ok: boolean;
  error?: string;
  roomId?: string;
  code?: string;
  playerId?: string;
  token?: string; // 重連用（存 localStorage）
}

export interface CreateRoomReq {
  name: string;
  isPublic?: boolean;
}
export interface JoinRoomReq {
  code: string;
  name: string;
}
export interface QuickMatchReq {
  name: string;
}
export interface ResumeReq {
  token: string;
}
export interface ActionReq {
  type: ActionType;
  cardId?: string; // discard/eat 時指定的牌
}

// ── Server → Client payloads ─────────────────────────────
export type { PersonalGameState, RoomView, GameOverPayload };
export interface ErrorPayload {
  message: string;
}
