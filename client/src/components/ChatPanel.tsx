import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@nine-cards/shared';

// 聊天面板：訊息列表＋輸入列。
// 等待室以 inline 常駐（佔版面）；牌桌以浮動面板掛在 .table 層（絕對定位，可收合）。
export function ChatPanel({
  messages,
  myPlayerId,
  onSend,
  inline = false,
  onClose,
}: {
  messages: ChatMessage[];
  myPlayerId: string | null;
  onSend: (text: string) => void;
  inline?: boolean; // true＝等待室常駐模式；false＝牌桌浮動模式（有關閉鈕）
  onClose?: () => void;
}) {
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 新訊息 → 自動捲到最底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    inputRef.current?.focus(); // 送出後保持輸入焦點，方便連續發言
  };

  return (
    <div className={`chat-panel ${inline ? 'inline' : ''}`}>
      {!inline && (
        <div className="chat-head">
          <span>聊天</span>
          <button className="chat-close" onClick={onClose} aria-label="關閉聊天">
            ✕
          </button>
        </div>
      )}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && <div className="chat-empty">（還沒有人說話）</div>}
        {messages.map((m) => (
          <div className={`chat-msg ${m.playerId === myPlayerId ? 'mine' : ''}`} key={m.ts + m.playerId}>
            <span className="chat-name">{m.playerId === myPlayerId ? '你' : m.name}</span>
            <span className="chat-text">{m.text}</span>
          </div>
        ))}
      </div>
      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={text}
          maxLength={100}
          placeholder="說點什麼…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn small" disabled={!text.trim()}>
          送出
        </button>
      </form>
    </div>
  );
}
