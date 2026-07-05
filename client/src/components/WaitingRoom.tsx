import type { GameApi } from '../useGame.js';

export function WaitingRoom({ api }: { api: GameApi }) {
  const room = api.room!;
  const me = api.identity;
  const isHost = me && room.hostId === me.playerId;
  const occupied = room.seats.filter((s) => s.playerId).length;
  const canStart = isHost && occupied >= 2;

  const shareLink = `${location.origin}?code=${room.code}`;

  return (
    <div className="waiting">
      <button className="btn ghost back" onClick={api.leave}>
        ← 離開
      </button>
      <h2>房間 {room.code}</h2>
      <p className="subtitle">
        {room.isPublic ? '公開房' : '私人房'}・新手提示{room.hints ? '開' : '關'}
        ・吃牌等待 {room.claimSeconds} 秒・分享房號給朋友加入
      </p>

      <button
        className="btn small"
        onClick={() => navigator.clipboard?.writeText(shareLink).then(() => undefined)}
      >
        複製邀請連結
      </button>

      <ul className="seat-list">
        {room.seats.map((s, i) => (
          <li key={i} className={s.playerId ? 'seat filled' : 'seat empty'}>
            <span className="seat-no">座位 {i + 1}</span>
            <span className="seat-name">
              {s.name ?? '（空）'}
              {s.playerId === room.hostId && ' 👑'}
              {s.playerId === me?.playerId && ' （你）'}
            </span>
            <span className={`dot ${s.connected ? 'on' : 'off'}`} />
          </li>
        ))}
      </ul>

      {isHost ? (
        <button className="btn primary" disabled={!canStart} onClick={api.startGame}>
          {occupied < 2 ? '等待玩家加入…' : '開始遊戲'}
        </button>
      ) : (
        <p className="hint">等待房主開始遊戲…</p>
      )}
    </div>
  );
}
