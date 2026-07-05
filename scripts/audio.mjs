// 把 audio/*.mp3（中文檔名的牌名語音）複製到 client/public/audio/{ascii}.mp3
// 用 ASCII 檔名避免 URL 編碼問題（與 slice.mjs 的卡面命名同一原則）
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'audio');
const OUT = join(ROOT, 'client', 'public', 'audio');

// 語音檔 → ASCII 名（拼音）。紅系牌（仕相俥傌）與綠系（士象車馬）同音共用，
// 綠色的語音檔為台語慣稱「青」；對照表見 client/src/sound.ts
const FILES = {
  黃: 'huang',
  紅: 'hong',
  青: 'qing',
  白: 'bai',
  帥: 'shuai',
  將: 'jiang',
  士: 'shi',
  象: 'xiang',
  車: 'che',
  馬: 'ma',
  炮: 'pao',
  包: 'bao',
  兵: 'bing',
  卒: 'zu',
  吃: 'chi',
  聽: 'ting',
  胡: 'hu',
};

await mkdir(OUT, { recursive: true });
for (const [cn, ascii] of Object.entries(FILES)) {
  await copyFile(join(SRC, `${cn}.mp3`), join(OUT, `${ascii}.mp3`));
}
console.log(`已複製 ${Object.keys(FILES).length} 個語音檔 → client/public/audio/`);
