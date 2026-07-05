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
  deadCards: Card[]; // 死牌（公開，等待配對或打出，§7.2）
  connected: boolean;
  isDealer: boolean;
  isTenpai: boolean; // 是否聽牌（§7）
  score: number; // 本場累計頭數（跨局；由 gameServer 維護）
}

// ── 對局中：送給「你自己」的完整資訊 ────────────────────
export interface SelfView {
  id: string;
  seat: number;
  hand: Card[]; // 只有自己看得到暗手牌（含死牌，死牌另由 deadIds 標示）
  melds: Card[][];
  deadIds: string[]; // 我的死牌（在 hand 中的 id，FIFO 順序）；出牌時須先出（§7.3）
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
  // 決定莊家（§4.1）：開局各玩家自己抽牌，draws 依座位索引（null＝尚未抽），
  // contenders＝仍在競爭的座位，decidedSeat＝已定莊並展示中的座位（null＝尚未定莊）；
  // 非此階段為 null
  dealerDraw: {
    draws: (Card | null)[];
    contenders: number[];
    decidedSeat: number | null;
  } | null;
  claimEndsAt: number | null; // 吃牌時間窗結束的 epoch ms（null = 非時間窗）
  legalActions: ActionType[]; // 伺服器告訴你此刻可做的動作
  winnerSeat: number | null;
  message: string | null;
}

export interface PaymentEntry {
  seat: number;
  delta: number; // 本局頭數變化（贏家為正、付家為負）
}

export interface ScoreEntry {
  seat: number;
  total: number; // 本場累計頭數
}

/** 一局結束（胡牌或流局）的結算資訊。 */
export interface GameOverPayload {
  winnerSeat: number | null; // null = 流局
  winnerName: string | null;
  reason: 'win' | 'draw';
  category: string; // 胡牌方式標籤（自摸／放槍…）；流局為空
  heads: number; // 贏家每位付家收取的頭數
  breakdown: { color: number; huKai: number; drawFive: number };
  drawFive: { cards: Card[]; qualifying: number } | null; // 抽五隻揭示（不符資格為 null）
  payments: PaymentEntry[]; // 本局各座位頭數變化
  scores: ScoreEntry[]; // 跨局累計（由 gameServer 填入）
  nextDealerSeat: number | null; // 下一局莊家（由 gameServer 填入）
}
