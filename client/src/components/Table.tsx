import { useEffect, useRef, useState } from 'react';
import type { GameApi } from '../useGame.js';
import { Card } from './Card.js';
import type { PublicPlayer, Card as CardT } from '@nine-cards/shared';

export function Table({ api }: { api: GameApi }) {
  const g = api.game!;
  const [selected, setSelected] = useState<string | null>(null);

  const mySeat = g.you.seat;
  const opponents = g.players.filter((p) => p.seat !== mySeat).sort((a, b) => a.seat - b.seat);
  const canDiscard = g.legalActions.includes('discard');
  const canDraw = g.legalActions.includes('draw');
  const canEat = g.legalActions.includes('eat');
  const canWin = g.legalActions.includes('declareWin');
  const canPass = g.legalActions.includes('pass'); // 自摸保護：可「不吃」打出摸到的牌
  const myTurn = g.currentTurnSeat === mySeat;
  const turnName = g.players.find((p) => p.seat === g.currentTurnSeat)?.name ?? '';

  // ── 摸牌/出牌時：先在主畫面「翻牌」跳一下，再落入桌面 ──
  const [reveal, setReveal] = useState<{ card: CardT; label: string } | null>(null);
  const prevDrawnId = useRef<string | null>(null);
  const prevDiscardLen = useRef(g.discardPile.length);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let card: CardT | null = null;
    let label = '翻牌';
    if (g.lastDrawn && g.lastDrawn.card.id !== prevDrawnId.current) {
      card = g.lastDrawn.card;
      label = `${g.players.find((p) => p.seat === g.lastDrawn!.seat)?.name ?? ''} 摸到`;
    } else if (g.discardPile.length > prevDiscardLen.current) {
      card = g.discardPile[g.discardPile.length - 1];
      label = '打出';
    }
    prevDrawnId.current = g.lastDrawn?.card.id ?? null;
    prevDiscardLen.current = g.discardPile.length;
    if (card) {
      setReveal({ card, label });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setReveal(null), 1100);
    }
    return () => window.clearTimeout(timer.current);
  }, [g]);

  const discard = () => {
    if (selected) {
      api.act('discard', selected);
      setSelected(null);
    }
  };

  const prompt = canWin
    ? '你可以胡牌！'
    : canPass
      ? '自摸！可吃請按「吃」，不吃就點中央那張打出'
      : canEat
        ? '有人出牌，要吃請按「吃」'
        : canDraw
          ? g.pendingClaim
            ? '不吃的話，按「摸牌」換你'
            : '輪到你，請摸牌'
          : canDiscard
            ? selected
              ? '按「打出」送出這張牌'
              : '點選一張要打出的牌'
            : `等待 ${turnName} 行動…`;

  return (
    <div className="table">
      <header className="table-top">
        <span className="chip">房 {api.room?.code ?? g.roomId.slice(0, 4)}</span>
        <span className="chip">牌堆 {g.deckCount}</span>
        <span className={`chip turn ${myTurn ? 'me' : ''}`}>
          {myTurn ? '輪到你' : `輪到 ${turnName}`}
        </span>
      </header>

      <section className="opponents">
        {opponents.map((p) => (
          <OpponentSeat key={p.id} p={p} active={p.seat === g.currentTurnSeat} />
        ))}
      </section>

      {/* 桌面：牌堆 + 待吃的牌 + 棄牌區（一直顯示，不被覆蓋） */}
      <section className="center">
        <div className="table-felt">
          <div className="deck-badge">牌堆 {g.deckCount}</div>

          {/* 待決定的牌一直放在桌面中央，直到有人吃或時間到落入棄牌 */}
          {g.pendingClaim && (
            <div className={`current-offer ${canPass ? 'selfeat' : ''}`}>
              <div className="co-label">
                {canPass
                  ? '你自摸這張（不限時）'
                  : `${g.players.find((p) => p.seat === g.pendingClaim!.fromSeat)?.name} 的這張，可吃／胡`}
              </div>
              <Card
                card={g.pendingClaim.card}
                selectable={canPass}
                onClick={canPass ? () => api.act('pass') : undefined}
              />
              {canPass && <div className="co-hint">不吃 → 點這張打出</div>}
              {g.claimEndsAt && <CountdownBar endsAt={g.claimEndsAt} />}
            </div>
          )}

          <div className="discard-wrap">
            <div className="discard-label">桌面棄牌</div>
            <div className="discard-pile">
              {g.discardPile.length === 0 && <span className="empty-hint">（尚無棄牌）</span>}
              {g.discardPile.map((card, i) => (
                <Card key={card.id + i} card={card} small />
              ))}
            </div>
          </div>
        </div>
        {g.message && <div className="msg">{g.message}</div>}
      </section>

      {/* 我的區域：固定高度，melds 保留空間、動作列固定不跳動 */}
      <section className="me">
        {/* 吃牌（公開）與暗手牌同一列、同尺寸共用空間；中間以分隔線區隔 */}
        <div className="hand-row" aria-label="我的吃牌與手牌">
          {g.you.melds.map((pair, i) => (
            <div className="meld" key={`m${i}`}>
              {pair.map((card) => (
                <Card key={card.id} card={card} />
              ))}
            </div>
          ))}
          {g.you.melds.length > 0 && <div className="hand-divider" aria-hidden="true" />}
          {g.you.hand.map((card) => (
            <Card
              key={card.id}
              card={card}
              selectable={canDiscard}
              selected={selected === card.id}
              onClick={canDiscard ? () => setSelected(card.id) : undefined}
            />
          ))}
        </div>

        <div className="prompt">{prompt}</div>

        <div className="actions">
          <button className="btn primary act" disabled={!canDraw} onClick={() => api.act('draw')}>
            摸牌
          </button>
          <button
            className="btn primary act"
            disabled={!canDiscard || !selected}
            onClick={discard}
          >
            打出
          </button>
          <button className="btn act" disabled={!canEat} onClick={() => api.act('eat')}>
            吃
          </button>
          <button className="btn win act" disabled={!canWin} onClick={() => api.act('declareWin')}>
            胡！
          </button>
        </div>
      </section>

      {/* 翻牌動畫：先在主畫面跳一下（透明層、可穿透、自動消失） */}
      {reveal && (
        <div className="reveal-layer">
          <div className="reveal" key={reveal.card.id}>
            <div className="reveal-label">{reveal.label}</div>
            <Card card={reveal.card} big />
          </div>
        </div>
      )}

      {api.gameOver && (
        <div className="overlay">
          <div className="result">
            <h2>
              {api.gameOver.reason === 'draw'
                ? '流局'
                : `${api.gameOver.winnerName ?? ''} 胡牌！`}
            </h2>
            <button className="btn primary" onClick={api.leave}>
              離開牌桌
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// 吃牌時間窗倒數條：從剩餘時間縮到 0，讓玩家知道要在時間內決定
function CountdownBar({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [endsAt]);
  const total = 5000;
  const remain = Math.max(0, endsAt - now);
  const pct = Math.min(100, (remain / total) * 100);
  return (
    <div className="countdown">
      <div className="countdown-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function OpponentSeat({ p, active }: { p: PublicPlayer; active: boolean }) {
  return (
    <div className={`opp ${active ? 'active' : ''}`}>
      <div className="opp-head">
        {p.isDealer && '👑 '}
        {p.name}
        {!p.connected && ' 📴'}
      </div>
      {/* 吃牌（公開）與暗牌同一列，中間以分隔線區隔 */}
      <div className="opp-row">
        {p.melds.length > 0 && (
          <>
            <div className="opp-melds">
              {p.melds.map((pair, i) => (
                <div className="meld" key={i}>
                  {pair.map((card) => (
                    <Card key={card.id} card={card} small />
                  ))}
                </div>
              ))}
            </div>
            <div className="opp-divider" aria-hidden="true" />
          </>
        )}
        <div className="opp-hand">
          {Array.from({ length: p.handCount }).map((_, i) => (
            <Card key={i} faceDown small />
          ))}
        </div>
      </div>
    </div>
  );
}
