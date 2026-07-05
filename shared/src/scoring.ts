// 計分核心工具（純函式，前後端共用；權威計算仍在 server 執行）
// 對應規則：§11 基本計分（顏色）、§10.1 胡開、§9.2 抽五隻。單位為「頭數」。
import { type Card, kindKey } from './cards.js';

export interface DrawFiveResult {
  cards: Card[]; // 抽出的 5 張（不足 5 張則有幾張算幾張）
  qualifying: number; // 符合條件（與胡的那張同種）的張數
  heads: number; // 抽五隻總加頭
}

/** 依手中牌組顏色種數計分（§11）：1 色→5、2 色→3、3 色→2、4 色→0。 */
export function colorScore(owned: Card[]): number {
  const colors = new Set(owned.map((c) => c.color));
  switch (colors.size) {
    case 1:
      return 5;
    case 2:
      return 3;
    case 3:
      return 2;
    default:
      return 0; // 4 種
  }
}

/**
 * 胡開加頭（§10.1）。winningCard 為胡的那張牌；只有胡到「第 4 張相同」才算：
 *  - 原本 3 張全在暗手牌（聽最後一張）→ 加 5 頭。
 *  - 原本 3 張中有來自吃牌（melds，吃到四張相同）→ 加 1 頭。
 * 天胡／開手胡（無 winningCard）不適用。
 */
export function huKaiBonus(handBefore: Card[], melds: Card[][], winningCard: Card | null): number {
  if (!winningCard) return 0;
  const key = kindKey(winningCard);
  const inHand = handBefore.filter((c) => kindKey(c) === key).length;
  const inMelds = melds.flat().filter((c) => kindKey(c) === key).length;
  if (inHand + inMelds !== 3) return 0; // 胡的必須是第 4 張
  return inMelds === 0 ? 5 : 1;
}

/**
 * 抽五隻（§9.2）：胡牌後自牌堆抽 5 張，「符合條件」＝與胡的那張同種（同花同牌）。
 * 前四張每張 +1，第五張（最後一張）+2。會消耗傳入的 deck。
 */
export function drawFiveBonus(deck: Card[], winningCard: Card | null): DrawFiveResult {
  const cards: Card[] = [];
  let qualifying = 0;
  let heads = 0;
  if (winningCard) {
    const key = kindKey(winningCard);
    for (let i = 0; i < 5 && deck.length > 0; i++) {
      const c = deck.shift()!;
      cards.push(c);
      if (kindKey(c) === key) {
        qualifying++;
        heads += i === 4 ? 2 : 1; // 最後一張加兩頭
      }
    }
  }
  return { cards, qualifying, heads };
}
