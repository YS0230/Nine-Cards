import { useEffect, useState } from 'react';
import type { GameApi } from '../useGame.js';

const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '';

type Mode = 'menu' | 'join' | 'browse';

export function Lobby({ api }: { api: GameApi }) {
  const [name, setName] = useState(api.savedName);
  const [code, setCode] = useState(urlCode);
  const [mode, setMode] = useState<Mode>(urlCode ? 'join' : 'menu');

  const nameOk = name.trim().length > 0;

  // 進入「公開大廳」時訂閱即時房間清單，離開時取消
  const { watchLobby, unwatchLobby } = api;
  useEffect(() => {
    if (mode !== 'browse') return;
    watchLobby();
    return () => unwatchLobby();
  }, [mode, watchLobby, unwatchLobby]);

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
        <div className="menu">
          <button className="btn primary" disabled={!nameOk} onClick={() => api.createRoom(name, false)}>
            建立私人房
          </button>
          <button className="btn" disabled={!nameOk} onClick={() => api.createRoom(name, true)}>
            建立公開房
          </button>
          <button className="btn" disabled={!nameOk} onClick={() => setMode('browse')}>
            公開大廳
          </button>
          <button className="btn" disabled={!nameOk} onClick={() => setMode('join')}>
            輸入房號加入
          </button>
          <button className="btn ghost" disabled={!nameOk} onClick={() => api.quickMatch(name)}>
            快速配對
          </button>
        </div>
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

      {mode === 'browse' && (
        <div className="menu browse">
          <div className="browse-head">
            <span>公開房間（{api.lobby.length}）</span>
            <button className="btn small" onClick={() => api.quickMatch(name)} disabled={!nameOk}>
              快速配對
            </button>
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
          <button className="btn ghost" onClick={() => setMode('menu')}>
            返回
          </button>
        </div>
      )}

      {mode === 'menu' && (
        <p className="hint">最少 2 人、最多 4 人。同一局湊滿五對即胡牌。</p>
      )}
    </div>
  );
}
