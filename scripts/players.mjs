// 把玩家人形立牌素材複製到 client/public/players/{style}/{ascii}.{ext}
// 用 ASCII 檔名避免 URL 編碼問題（與 audio.mjs 的語音檔命名同一原則）。
// 三套畫風玩家可自選（大廳/等待室內即時切換）：
//   qb（去背，預設）＝ images/去背賭俠.png 等，已去背 PNG，3D 場景用 Sprite billboard
//   g7            ＝ images/G7賭俠.png 等，另一套已去背 PNG，同樣走 Sprite billboard
//   3d            ＝ images/3D賭俠.glb 等，實體 glTF 模型，3D 場景改用 GLTFLoader 載入
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'images');
const OUT = join(ROOT, 'client', 'public', 'players');

const CHARACTERS = {
  賭神: 'dishen',
  賭俠: 'dixia',
  賭聖: 'disheng',
};

const STYLES = [
  { dir: 'qb', prefix: '去背', ext: 'png' },
  { dir: 'g7', prefix: 'G7', ext: 'png' },
  { dir: '3d', prefix: '3D', ext: 'glb' },
];

let count = 0;
for (const style of STYLES) {
  const outDir = join(OUT, style.dir);
  await mkdir(outDir, { recursive: true });
  for (const [cn, ascii] of Object.entries(CHARACTERS)) {
    await copyFile(join(SRC, `${style.prefix}${cn}.${style.ext}`), join(outDir, `${ascii}.${style.ext}`));
    count++;
  }
}
console.log(`已複製 ${count} 個玩家人形立牌素材 → client/public/players/{qb,g7,3d}/`);
