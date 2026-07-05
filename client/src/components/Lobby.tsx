import { useEffect, useState } from 'react';
import type { GameApi } from '../useGame.js';

const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '';

type Mode = 'menu' | 'join';

export function Lobby({ api }: { api: GameApi }) {
  const [name, setName] = useState(api.savedName);
  const [code, setCode] = useState(urlCode);
  const [mode, setMode] = useState<Mode>(urlCode ? 'join' : 'menu');
  const [hints, setHints] = useState(true); // 建房選項：新手提示（可吃/胡才啟用按鈕）

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
        <input
          value={name}
          maxLength={12}
          placeholder="輸入你的暱稱"
          onChange={(e) => setName(e.target.value)}
        />
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
            <button
              className="btn primary"
              disabled={!nameOk}
              onClick={() => api.createRoom(name, true, hints)}
            >
              建立公開房
            </button>
            <div className="menu-row">
              <button
                className="btn"
                disabled={!nameOk}
                onClick={() => api.createRoom(name, false, hints)}
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
