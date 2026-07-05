// 牌名語音：出牌／摸牌公開時報「顏色＋牌名」（例：紅車 → hong.mp3 + che.mp3）
// 音檔由 `npm run audio` 從根目錄 audio/ 複製到 client/public/audio/（ASCII 檔名）
import type { Card, Color, Rank } from '@nine-cards/shared';

// 綠色的語音檔為台語慣稱「青」
const COLOR_SOUND: Record<Color, string> = { 黃: 'huang', 紅: 'hong', 綠: 'qing', 白: 'bai' };
// 紅系（仕相俥傌）與綠系（士象車馬）同音，共用同一個語音檔
const RANK_SOUND: Record<Rank, string> = {
  帥: 'shuai',
  仕: 'shi',
  相: 'xiang',
  俥: 'che',
  傌: 'ma',
  炮: 'pao',
  兵: 'bing',
  將: 'jiang',
  士: 'shi',
  象: 'xiang',
  車: 'che',
  馬: 'ma',
  包: 'bao',
  卒: 'zu',
};
// 動作音效：吃牌（手中死牌就地湊對時改播「撿」）／聽牌／胡牌（自摸另用專屬音效）／打出死牌
const EFFECT_SOUND = {
  eat: 'chi',
  pickupDead: 'jian',
  tenpai: 'ting',
  win: 'hu',
  selfDrawWin: 'zimo',
  deadCard: 'sipai',
} as const;
export type EffectKind = keyof typeof EFFECT_SOUND;

// 每個音檔約 1 秒但發聲只佔一小段；先掃出實際發聲區間，播放時去掉頭尾靜音
interface VoiceClip {
  buffer: AudioBuffer;
  start: number; // 發聲起點（秒）
  dur: number; // 發聲長度（秒）
}

let ctx: AudioContext | null = null;
let queueEnd = 0; // 排隊播放：下一段語音的起始時間（連續多張不重疊）
const buffers = new Map<string, Promise<VoiceClip | null>>();

// 行動瀏覽器禁止自動出聲：第一次觸碰／點擊時建立並解鎖 AudioContext，順便預載全部語音
function unlock() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  const all = [
    ...Object.values(COLOR_SOUND),
    ...Object.values(RANK_SOUND),
    ...Object.values(EFFECT_SOUND),
  ];
  for (const name of new Set(all)) void loadBuffer(name);
  if (ctx.state === 'running') {
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  }
}
document.addEventListener('pointerdown', unlock);
document.addEventListener('keydown', unlock);

function loadBuffer(name: string): Promise<VoiceClip | null> {
  let p = buffers.get(name);
  if (!p) {
    p = fetch(`/audio/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => ctx!.decodeAudioData(data))
      .then(voicedClip)
      .catch(() => null); // 音檔缺漏（未跑 npm run audio）→ 靜音略過，不影響遊戲
    buffers.set(name, p);
  }
  return p;
}

// 掃描振幅找出實際發聲區間（門檻取峰值的 5%），頭尾各保留一點避免切到字
function voicedClip(buffer: AudioBuffer): VoiceClip {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const th = Math.max(peak * 0.05, 0.004);
  let s = 0;
  while (s < data.length && Math.abs(data[s]) < th) s++;
  let e = data.length - 1;
  while (e > s && Math.abs(data[e]) < th) e--;
  const sr = buffer.sampleRate;
  const start = Math.max(0, s / sr - 0.02);
  const end = Math.min(buffer.duration, e / sr + 0.05);
  return { buffer, start, dur: Math.max(0, end - start) };
}

/** 報牌名：依序播放「顏色、牌名」兩段語音；解鎖前（尚無使用者手勢）靜音略過。 */
export function playCardVoice(card: Card): Promise<void> {
  return playNames([COLOR_SOUND[card.color], RANK_SOUND[card.rank]]);
}

/** 動作音效：吃／聽／胡。與報牌共用同一條播放佇列，不會疊音。 */
export function playEffect(kind: EffectKind): Promise<void> {
  return playNames([EFFECT_SOUND[kind]]);
}

async function playNames(names: string[]): Promise<void> {
  if (!ctx || ctx.state !== 'running') return;
  const parts = await Promise.all(names.map(loadBuffer));
  // 排在前一段語音之後；積壓太多（>2 秒）就直接跟上，避免語音越落越遠
  const WORD_GAP = 0.03; // 兩字之間的自然間隔（秒）
  let at = Math.max(ctx.currentTime, Math.min(queueEnd, ctx.currentTime + 2));
  for (const clip of parts) {
    if (!clip) continue;
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.connect(ctx.destination);
    src.start(at, clip.start, clip.dur); // 只播發聲區間，去掉頭尾靜音
    at += clip.dur + WORD_GAP;
  }
  queueEnd = at;
}
