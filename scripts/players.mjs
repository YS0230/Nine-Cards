// 把 images/去背賭神.png 等已去背的玩家人形立牌圖複製到 client/public/players/{ascii}.png
// 用 ASCII 檔名避免 URL 編碼問題（與 audio.mjs 的語音檔命名同一原則）。
// 來源圖已內建透明 alpha（非白底），3D 場景用 Sprite billboard 顯示，呈現「站在桌上」的 2.5D 立牌效果。
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'images');
const OUT = join(ROOT, 'client', 'public', 'players');

const FILES = {
  去背賭神: 'dishen',
  去背賭俠: 'dixia',
  去背賭聖: 'disheng',
};

await mkdir(OUT, { recursive: true });
for (const [cn, ascii] of Object.entries(FILES)) {
  await copyFile(join(SRC, `${cn}.png`), join(OUT, `${ascii}.png`));
}
console.log(`已複製 ${Object.keys(FILES).length} 個玩家人形圖 → client/public/players/`);
