import type { Card } from './cards.js';

export type RoomPhase = 'WAITING' | 'PLAYING' | 'FINISHED';

export type ActionType = 'draw' | 'discard' | 'eat' | 'pass' | 'declareWin';

// ── 大廳/房間（未開局）視圖 ──────────────────────────────
export interface RoomSeat {
  playerId: string | null;
  name: string | null;
  connected: boolean;
}

export interface RoomView {
  roomId: string;
  code: string; // 分享用房號
  phase: RoomPhase;
  isPublic: boolean;
  seats: RoomSeat[];
  hostId: string | null;
  maxPlayers: number;
}

// 公開大廳中每個可加入房間的摘要
export interface LobbyRoom {
  code: string;
  hostName: string;
  count: number;
  maxPlayers: number;
}

// ── 對局中：送給「其他玩家」看到的公開資訊 ──────────────
export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  handCount: number; // 只給暗牌張數，不給內容
  melds: Card[][]; // 已公開的吃牌對子
  connected: boolean;
  isDealer: boolean;
}

// ── 對局中：送給「你自己」的完整資訊 ────────────────────
export interface SelfView {
  id: string;
  seat: number;
  hand: Card[]; // 只有自己看得到暗手牌
  melds: Card[][];
}

/** 伺服器針對每位玩家個別產生的對局狀態（隱藏他人手牌）。 */
export interface PersonalGameState {
  roomId: string;
  phase: RoomPhase;
  players: PublicPlayer[];
  you: SelfView;
  deckCount: number;
  discardPile: Card[]; // 棄牌區（§6.2）
  currentTurnSeat: number;
  lastDrawn: { seat: number; card: Card } | null; // 剛摸出並公開的牌（§6.1）
  pendingClaim: { card: Card; fromSeat: number } | null; // 正在等待吃/過的牌
  claimEndsAt: number | null; // 吃牌時間窗結束的 epoch ms（null = 非時間窗）
  legalActions: ActionType[]; // 伺服器告訴你此刻可做的動作
  winnerSeat: number | null;
  message: string | null;
}

export interface GameOverPayload {
  winnerSeat: number | null; // null = 流局
  winnerName: string | null;
  reason: 'win' | 'draw';
}
