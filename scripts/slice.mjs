// 把 Sprite Sheet.png（960×494，2×2 色塊，每塊 7 張）切成 28 張牌面
// 輸出到 client/public/cards/{colorCode}{rankIndex}.png，例如 y0.png=黃帥、w6.png=白卒
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'Sprite Sheet.png');
const OUT = join(ROOT, 'client', 'public', 'cards');

// 色塊在整張圖中的左上座標與尺寸
const SHEET_W = 960;
const SHEET_H = 494;
const BLOCK_W = SHEET_W / 2; // 480
const BLOCK_H = SHEET_H / 2; // 247
const CARDS_PER_BLOCK = 7;

// colorCode 對應四個色塊（左上黃、右上綠、左下紅、右下白）
const BLOCKS = [
  { code: 'y', bx: 0, by: 0 }, // 黃
  { code: 'g', bx: BLOCK_W, by: 0 }, // 綠
  { code: 'r', bx: 0, by: BLOCK_H }, // 紅
  { code: 'w', bx: BLOCK_W, by: BLOCK_H }, // 白
];

// 讓 7 張牌無縫平鋪（避免累積捨入誤差）
function edge(i) {
  return Math.round((i * BLOCK_W) / CARDS_PER_BLOCK);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const meta = await sharp(SRC).metadata();
  if (meta.width !== SHEET_W || meta.height !== SHEET_H) {
    console.warn(`⚠ 來源尺寸為 ${meta.width}×${meta.height}，預期 ${SHEET_W}×${SHEET_H}，座標可能需微調`);
  }
  let count = 0;
  for (const { code, bx, by } of BLOCKS) {
    for (let i = 0; i < CARDS_PER_BLOCK; i++) {
      const left = Math.round(bx) + edge(i);
      const width = edge(i + 1) - edge(i);
      const top = Math.round(by);
      const height = Math.round(BLOCK_H);
      const out = join(OUT, `${code}${i}.png`);
      await sharp(SRC).extract({ left, top, width, height }).toFile(out);
      count++;
    }
  }
  console.log(`✓ 已輸出 ${count} 張牌面到 ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
