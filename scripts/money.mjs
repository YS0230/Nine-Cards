// 把 images/*.png（鈔票／錢幣面額圖）複製到 client/public/money/{面額}.png
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'images');
const OUT = join(ROOT, 'client', 'public', 'money');

await mkdir(OUT, { recursive: true });
// 只挑面額圖（純數字檔名），避免連同 images/ 下其他用途的圖檔（如玩家人形立牌）一併複製
const files = (await readdir(SRC)).filter((f) => /^\d+\.png$/.test(f));
for (const f of files) {
  await copyFile(join(SRC, f), join(OUT, f));
}
console.log(`已複製 ${files.length} 個金額圖檔 → client/public/money/`);
