// 把 images/*.png（鈔票／錢幣面額圖）複製到 client/public/money/{面額}.png
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'images');
const OUT = join(ROOT, 'client', 'public', 'money');

await mkdir(OUT, { recursive: true });
const files = (await readdir(SRC)).filter((f) => f.endsWith('.png'));
for (const f of files) {
  await copyFile(join(SRC, f), join(OUT, f));
}
console.log(`已複製 ${files.length} 個金額圖檔 → client/public/money/`);
