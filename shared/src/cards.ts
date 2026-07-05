// 牌組定義與規則核心工具（前後端共用；權威判定仍在 server 執行）

export type Color = '黃' | '紅' | '綠' | '白';

// 黃/紅 使用帥系；綠/白 使用將系（規則 §2.1）
export type RedRank = '帥' | '仕' | '相' | '俥' | '傌' | '炮' | '兵';
export type GreenRank = '將' | '士' | '象' | '車' | '馬' | '包' | '卒';
export type Rank = RedRank | GreenRank;

export interface Card {
  id: string; // 唯一識別，例如 "黃_帥_2"
  color: Color;
  rank: Rank;
}

export const COLORS: Color[] = ['黃', '紅', '綠', '白'];
export const RED_RANKS: RedRank[] = ['帥', '仕', '相', '俥', '傌', '炮', '兵'];
export const GREEN_RANKS: GreenRank[] = ['將', '士', '象', '車', '馬', '包', '卒'];

// 每個花色對應的 7 種牌
export const RANKS_BY_COLOR: Record<Color, Rank[]> = {
  黃: RED_RANKS,
  紅: RED_RANKS,
  綠: GREEN_RANKS,
  白: GREEN_RANKS,
};

export const COPIES_PER_KIND = 4; // 每種 4 張（§2.3）
export const WIN_PAIRS = 5; // 五對即胡（§3）

// 抽牌決定莊家用的權重（§4.1）；帥/將=7 ... 兵/卒=1
export const RANK_WEIGHT: Record<Rank, number> = {
  帥: 7, 仕: 6, 相: 5, 俥: 4, 傌: 3, 炮: 2, 兵: 1,
  將: 7, 士: 6, 象: 5, 車: 4, 馬: 3, 包: 2, 卒: 1,
};

// 顏色比較權重（§4.1：黃>紅>綠>白）
export const COLOR_WEIGHT: Record<Color, number> = { 黃: 4, 紅: 3, 綠: 2, 白: 1 };

/** 建立一副 112 張的完整牌組。 */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    for (const rank of RANKS_BY_COLOR[color]) {
      for (let copy = 1; copy <= COPIES_PER_KIND; copy++) {
        deck.push({ id: `${color}_${rank}_${copy}`, color, rank });
      }
    }
  }
  return deck; // 4 花色 × 7 種 × 4 張 = 112
}

/** 洗牌（Fisher–Yates）。傳入 rng 以便測試可重現。 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 同一種牌的鍵（同花同種才視為同一種）。 */
export function kindKey(card: Card): string {
  return `${card.color}_${card.rank}`;
}

/** 兩張是否能成一對：同顏色且同牌種（§8）。 */
export function isPair(a: Card, b: Card): boolean {
  return a.color === b.color && a.rank === b.rank;
}

/** 依牌種分組計數。 */
export function groupCounts(cards: Card[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards) m.set(kindKey(c), (m.get(kindKey(c)) ?? 0) + 1);
  return m;
}

/** 這批牌中可湊出的對子數（多出的單張不計，§8 三張時第 3 張算單張）。 */
export function countPairs(cards: Card[]): number {
  let pairs = 0;
  for (const n of groupCounts(cards).values()) pairs += Math.floor(n / 2);
  return pairs;
}

/**
 * 判斷一整組牌是否為胡牌牌型：恰好 5 對、10 張、且每一種牌都成雙（無單張）。
 * allCards 應為玩家「暗手牌 + 已公開吃牌對子」的全部牌。
 */
export function isWinningSet(allCards: Card[]): boolean {
  if (allCards.length !== WIN_PAIRS * 2) return false;
  for (const n of groupCounts(allCards).values()) {
    if (n % 2 !== 0) return false; // 有單張或三張 → 未胡
  }
  return true;
}

/**
 * 手牌中是否有可與 card 成對的牌（可吃/可胡的前提，§7.1）。
 * 需手牌中該牌種的張數為「奇數」才可吃：吃進後恰好補成整對；
 * 若已持有整對（偶數張）則吃進只會多出單張，不可吃。
 */
export function hasMatch(hand: Card[], card: Card): boolean {
  const count = hand.filter((c) => isPair(c, card)).length;
  return count % 2 === 1;
}

// ── 牌面圖檔命名（切圖與前端共用；用 ASCII 避免 URL 編碼問題）──
export const COLOR_CODE: Record<Color, string> = { 黃: 'y', 紅: 'r', 綠: 'g', 白: 'w' };

/** 牌在其花色 7 種牌中的索引（0..6）。 */
export function rankIndex(card: Card): number {
  return RANKS_BY_COLOR[card.color].indexOf(card.rank);
}

/** 牌面圖檔名（不含副檔名），例如 黃帥→"y0"、白卒→"w6"。 */
export function cardImageBase(card: Card): string {
  return `${COLOR_CODE[card.color]}${rankIndex(card)}`;
}
