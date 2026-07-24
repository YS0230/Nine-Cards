import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@nine-cards/shared';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 同一人在 5 分鐘內的連續發言合併成一組，只顯示一次名字＋時間
const GROUP_GAP_MS = 5 * 60_000;

interface MsgGroup {
  key: string;
  mine: boolean;
  name: string;
  ts: number;
  msgs: ChatMessage[];
}

function groupMessages(messages: ChatMessage[], myPlayerId: string | null): MsgGroup[] {
  const groups: MsgGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const lastMsg = last?.msgs[last.msgs.length - 1];
    if (last && lastMsg && lastMsg.playerId === m.playerId && m.ts - lastMsg.ts < GROUP_GAP_MS) {
      last.msgs.push(m);
    } else {
      groups.push({
        key: `${m.ts}-${m.playerId}`,
        mine: m.playerId === myPlayerId,
        name: m.name,
        ts: m.ts,
        msgs: [m],
      });
    }
  }
  return groups;
}

// 聊天面板：訊息列表（氣泡＋名字/時間）＋輸入列。
// 等待室以 inline 常駐（佔版面、隨空間伸縮）；牌桌以浮動面板掛在 .table 層（絕對定位，可收合）。
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
  const [hasNew, setHasNew] = useState(false); // 往回看歷史時有新訊息 → 顯示跳到最底的提示
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nearBottomRef = useRef(true); // 是否貼近底部（貼近才自動跟捲，避免看歷史被拉走）

  const scrollToBottom = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setHasNew(false);
  };

  // 新訊息：貼底時自動跟捲；否則亮「新訊息」提示，不打斷閱讀
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom();
    else if (messages.length > 0) setHasNew(true);
  }, [messages]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottomRef.current) setHasNew(false);
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    nearBottomRef.current = true; // 自己發言一定跟捲到底
    inputRef.current?.focus(); // 送出後保持輸入焦點，方便連續發言
  };

  const groups = groupMessages(messages, myPlayerId);

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
      <div className="chat-log-wrap">
        <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
          {messages.length === 0 && <div className="chat-empty">（還沒有人說話）</div>}
          {groups.map((g) => (
            <div className={`chat-group ${g.mine ? 'mine' : ''}`} key={g.key}>
              <div className="chat-meta">
                {!g.mine && <span className="chat-name">{g.name}</span>}
                <span className="chat-time">{fmtTime(g.ts)}</span>
              </div>
              {g.msgs.map((m) => (
                <div className="chat-msg" key={`${m.ts}-${m.playerId}`}>
                  {m.text}
                </div>
              ))}
            </div>
          ))}
        </div>
        {hasNew && (
          <button className="chat-new" onClick={scrollToBottom}>
            ↓ 新訊息
          </button>
        )}
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
          enterKeyHint="send"
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn small" disabled={!text.trim()}>
          送出
        </button>
      </form>
    </div>
  );
}
