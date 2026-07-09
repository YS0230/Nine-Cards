import { useEffect, useState } from 'react';
import type { GameApi } from '../useGame.js';

const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '';

type Mode = 'menu' | 'join';

// 首次遊玩、尚未存過暱稱時隨機帶入的趣味暱稱，讓玩家不用自己想名字
const FUN_NAMES = [
  '摸牌大師',
  '天胡本人',
  '相公專業戶',
  '吃貨代表',
  '運氣爆棚',
  '牌桌千王',
  '一夜致富',
  '躺贏選手',
  '手氣製造機',
  '出老千的',
  '胡牌預備軍',
  '牌運女神',
  '默默聽牌中',
  '賭神二代',
  '摳門莊家',
  '九支仔王',
  '開交王',
];

function randomFunName(exclude?: string) {
  if (FUN_NAMES.length <= 1) return FUN_NAMES[0];
  let n = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
  while (n === exclude) n = FUN_NAMES[Math.floor(Math.random() * FUN_NAMES.length)];
  return n;
}

export function Lobby({ api }: { api: GameApi }) {
  const [name, setName] = useState(() => api.savedName || randomFunName());
  const [code, setCode] = useState(urlCode);
  const [mode, setMode] = useState<Mode>(urlCode ? 'join' : 'menu');
  const [hints, setHints] = useState(false); // 建房選項：新手提示（可吃/胡才啟用按鈕）
  const [claimSeconds, setClaimSeconds] = useState(2); // 建房選項：吃牌窗等待秒數
  const [startingCapital, setStartingCapital] = useState(2000); // 建房選項：本金（每位玩家初始金額）
  const [unitBet, setUnitBet] = useState(50); // 建房選項：一頭金額

  const nameOk = name.trim().length > 0;

  // 首頁即時訂閱公開房間清單（直接顯示在首頁，不需另開分頁）。
  // 必須等 socket 連上（connected）才訂閱：子元件的 effect 早於 useGame 建立 socket，
  // 太早呼叫 watchLobby 會因 socket 尚未存在而無效；斷線重連時 connected 轉真也會重新訂閱。
  const { watchLobby, unwatchLobby, connected } = api;
  useEffect(() => {
    if (mode !== 'menu' || !connected) return;
    watchLobby();
    return () => unwatchLobby();
  }, [mode, connected, watchLobby, unwatchLobby]);

  return (
    <div className="lobby">
      <h1 className="title">九支仔</h1>
      <p className="subtitle">即時多人連線對戰</p>

      <label className="field">
        <span>暱稱</span>
        <div className="field-with-action">
          <input
            value={name}
            maxLength={12}
            placeholder="輸入你的暱稱"
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="btn small ghost"
            title="不喜歡這個暱稱？換一個"
            onClick={() => setName(randomFunName(name))}
          >
            換一個
          </button>
        </div>
      </label>

      {mode === 'menu' && (
        <>
          <div className="menu">
            {/* 建房選項：新手提示（關閉時吃/胡按鈕不自動鎖定，按下後由伺服器判定） */}
            <label className="field-check">
              <input
                type="checkbox"
                checked={hints}
                onChange={(e) => setHints(e.target.checked)}
              />
              <span>
                新手提示
                <small>開：可吃/胡時才能按按鈕；關：按鈕不鎖定，由伺服器判定</small>
              </span>
            </label>
            {/* 建房選項：吃牌等待秒數（下家需等此秒數且無人宣告才可摸牌） */}
            <label className="field-select">
              <span>吃牌等待秒數</span>
              <select
                value={claimSeconds}
                onChange={(e) => setClaimSeconds(Number(e.target.value))}
              >
                {[1, 2, 3, 5, 8, 10, 15].map((s) => (
                  <option key={s} value={s}>
                    {s} 秒
                  </option>
                ))}
              </select>
            </label>
            {/* 建房選項：本金（每位玩家初始金額） */}
            <label className="field-select">
              <span>本金</span>
              <select
                value={startingCapital}
                onChange={(e) => setStartingCapital(Number(e.target.value))}
              >
                {[500, 1000, 2000, 3000, 5000].map((v) => (
                  <option key={v} value={v}>
                    {v} 元
                  </option>
                ))}
              </select>
            </label>
            {/* 建房選項：一頭金額（頭數換算成錢的單價） */}
            <label className="field-select">
              <span>一頭</span>
              <select value={unitBet} onChange={(e) => setUnitBet(Number(e.target.value))}>
                {[10, 20, 50, 100, 200].map((v) => (
                  <option key={v} value={v}>
                    {v} 元
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn primary"
              disabled={!nameOk}
              onClick={() => api.createRoom(name, true, hints, claimSeconds, startingCapital, unitBet)}
            >
              建立公開房
            </button>
            <div className="menu-row">
              <button
                className="btn"
                disabled={!nameOk}
                onClick={() => api.createRoom(name, false, hints, claimSeconds, startingCapital, unitBet)}
              >
                建立私人房
              </button>
              <button className="btn" disabled={!nameOk} onClick={() => setMode('join')}>
                輸入房號
              </button>
            </div>
            <button className="btn ghost" disabled={!nameOk} onClick={() => api.quickMatch(name)}>
              快速配對
            </button>
          </div>

          {/* 公開大廳：即時顯示在首頁 */}
          <div className="browse">
            <div className="browse-head">
              <span>公開房間（{api.lobby.length}）</span>
            </div>
            {api.lobby.length === 0 ? (
              <p className="hint">目前沒有公開房間，按「建立公開房」開一桌吧！</p>
            ) : (
              <ul className="room-list">
                {api.lobby.map((r) => (
                  <li key={r.code} className="room-row">
                    <div className="room-info">
                      <span className="room-code">{r.code}</span>
                      <span className="room-host">{r.hostName} 的房間</span>
                    </div>
                    <span className="room-count">
                      {r.count}/{r.maxPlayers}
                    </span>
                    <button
                      className="btn small primary"
                      disabled={!nameOk}
                      onClick={() => api.joinRoom(r.code, name)}
                    >
                      加入
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="hint">最少 2 人、最多 4 人。同一局湊滿五對即胡牌。</p>
        </>
      )}

      {mode === 'join' && (
        <div className="menu">
          <label className="field">
            <span>房號</span>
            <input
              value={code}
              maxLength={4}
              placeholder="4 碼房號"
              autoCapitalize="characters"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <button
            className="btn primary"
            disabled={!nameOk || code.trim().length < 4}
            onClick={() => api.joinRoom(code, name)}
          >
            加入
          </button>
          <button className="btn ghost" onClick={() => setMode('menu')}>
            返回
          </button>
        </div>
      )}
    </div>
  );
}
