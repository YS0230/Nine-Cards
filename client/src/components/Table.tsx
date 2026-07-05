import { useEffect, useRef, useState } from 'react';
import type { GameApi } from '../useGame.js';
import { Card } from './Card.js';
import { playCardVoice, playEffect } from '../sound.js';
import type { PublicPlayer, Card as CardT, GameOverPayload, DrawFiveView } from '@nine-cards/shared';

export function Table({ api }: { api: GameApi }) {
  const g = api.game!;
  const [selected, setSelected] = useState<string | null>(null);

  const mySeat = g.you.seat;
  const opponents = g.players.filter((p) => p.seat !== mySeat).sort((a, b) => a.seat - b.seat);
  const me = g.players.find((p) => p.seat === mySeat);
  const myScore = me?.score ?? 0;
  const myTenpai = me?.isTenpai ?? false;
  const myXianggong = me?.isXianggong ?? false; // 相公：本局僅能觀看
  const deadIdSet = new Set(g.you.deadIds); // 我的死牌 id（出牌時須先出，§7.3）
  const hasDead = deadIdSet.size > 0;
  // 死牌移到公開區顯示（依 FIFO 順序）；暗手牌只留非死牌
  const myDeadCards = g.you.deadIds
    .map((id) => g.you.hand.find((c) => c.id === id))
    .filter((c): c is CardT => !!c);
  const myHandCards = g.you.hand.filter((c) => !deadIdSet.has(c.id));
  const canDiscard = g.legalActions.includes('discard');
  const canDraw = g.legalActions.includes('draw');
  const canEat = g.legalActions.includes('eat');
  const canWin = g.legalActions.includes('declareWin');
  const canPass = g.legalActions.includes('pass'); // 自摸保護：可「不吃」打出摸到的牌
  const myTurn = g.currentTurnSeat === mySeat;
  const turnName = g.players.find((p) => p.seat === g.currentTurnSeat)?.name ?? '';
  const nameOf = (seat: number) =>
    seat === mySeat ? '你' : (g.players.find((p) => p.seat === seat)?.name ?? `座位${seat}`);

  // ── 摸牌/出牌時：先在主畫面「翻牌」跳一下，再落入桌面 ──
  const [reveal, setReveal] = useState<{ card: CardT; label: string } | null>(null);
  const prevDrawnId = useRef<string | null>(null);
  const prevEatKey = useRef<string | null>(null);
  const prevDiscardLen = useRef(g.discardPile.length);
  const timer = useRef<number | undefined>(undefined);
  // 已報過牌名的牌 id（牌 id 每局重複使用，換局時清空重計）
  const announced = useRef(new Set<string>());
  // 音效觸發判斷用：上一次的贏家／各座位聽牌狀態（useRef 初值＝進場當下，避免重連時補播）
  const prevWinner = useRef(g.winnerSeat);
  const prevTenpai = useRef(new Map(g.players.map((p) => [p.seat, p.isTenpai])));

  useEffect(() => {
    // ── 報牌語音：牌第一次公開（摸出／打出）時唸出「顏色＋牌名」，同一張只報一次 ──
    if (g.discardPile.length < prevDiscardLen.current) announced.current.clear(); // 新的一局
    const announce = (c: CardT) => {
      if (announced.current.has(c.id)) return;
      announced.current.add(c.id);
      void playCardVoice(c);
    };
    if (g.lastDrawn) announce(g.lastDrawn.card);
    if (g.pendingClaim) announce(g.pendingClaim.card); // 打出待吃的牌（摸出的同張已去重）
    for (const c of g.discardPile.slice(prevDiscardLen.current)) announce(c); // 無人可吃直接落桌

    // ── 動作音效：吃／聽／胡（與報牌共用播放佇列，依序不疊音）──
    if (g.winnerSeat != null && prevWinner.current == null) void playEffect('win');
    prevWinner.current = g.winnerSeat;
    for (const p of g.players) {
      if (p.isTenpai && !prevTenpai.current.get(p.seat)) void playEffect('tenpai'); // 新聽牌
      prevTenpai.current.set(p.seat, p.isTenpai);
    }
    let card: CardT | null = null;
    let label = '翻牌';
    // 吃牌（含被更高優先者搶吃）以「座位+牌」為鍵，換人吃同一張也會再跳一次
    const eatKey = g.eating ? `${g.eating.seat}:${g.eating.card.id}` : null;
    if (eatKey && eatKey !== prevEatKey.current) void playEffect('eat'); // 含被高優先者搶吃
    if (g.lastDrawn && g.lastDrawn.card.id !== prevDrawnId.current) {
      card = g.lastDrawn.card;
      label = `${g.players.find((p) => p.seat === g.lastDrawn!.seat)?.name ?? ''} 摸到`;
    } else if (g.eating && eatKey !== prevEatKey.current) {
      card = g.eating.card;
      label = `${nameOf(g.eating.seat)} 吃了`;
    } else if (g.discardPile.length > prevDiscardLen.current) {
      card = g.discardPile[g.discardPile.length - 1];
      label = '打出';
    }
    prevDrawnId.current = g.lastDrawn?.card.id ?? null;
    prevEatKey.current = eatKey;
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

  // 離開遊戲（§13）：確認後退出本場，回到大廳
  const onLeaveClick = () => {
    if (window.confirm('確定要離開這場遊戲嗎？')) api.leave();
  };

  const prompt = myXianggong
    ? '你已相公（逾時未吃），本局僅能觀看'
    : canWin
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
            ? hasDead
              ? '手上有死牌，需先打出死牌'
              : selected
                ? '按「打出」送出這張牌'
                : '點選一張要打出的牌'
            : `等待 ${turnName} 行動…`;

  return (
    <div className="table">
      <header className="table-top">
        <span className="chip">房 {api.room?.code ?? g.roomId.slice(0, 4)}</span>
        <span className="chip">牌堆 {g.deckCount}</span>
        <span className="chip">
          我 {myScore} 頭{myTenpai && ' · 聽'}
          {myXianggong && <span className="xg-badge">相公</span>}
        </span>
        <span className={`chip turn ${myTurn ? 'me' : ''}`}>
          {myTurn ? '輪到你' : `輪到 ${turnName}`}
        </span>
        <button className="chip leave-chip" onClick={onLeaveClick}>
          離開
        </button>
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

          {/* 有人吃牌：公開顯示誰吃了哪張（待其打出定案；期間高優先者仍可搶） */}
          {g.eating && (
            <div className="current-offer eaten">
              <div className="co-label">{nameOf(g.eating.seat)} 吃了這張</div>
              <Card card={g.eating.card} />
              <div className="co-hint">
                {g.eating.seat === mySeat ? '請打出一張牌' : `等待 ${nameOf(g.eating.seat)} 出牌…`}
              </div>
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
        {/* 公開區（吃牌對子＋死牌單張）｜分隔線｜暗手牌，同一列、同尺寸、依寬度自動縮放 */}
        <div className="hand-row" aria-label="我的公開區與手牌">
          {g.you.melds.map((pair, i) => (
            <div className="meld" key={`m${i}`}>
              {pair.map((card) => (
                <Card key={card.id} card={card} />
              ))}
            </div>
          ))}
          {/* 死牌：公開區中的單張（未成對即為死牌，§7.2），有死牌時即為可打出的牌 */}
          {myDeadCards.map((card) => (
            <div className="dead-single" key={card.id}>
              <Card
                card={card}
                selectable={canDiscard}
                selected={selected === card.id}
                onClick={canDiscard ? () => setSelected(card.id) : undefined}
              />
            </div>
          ))}
          {(g.you.melds.length > 0 || myDeadCards.length > 0) && (
            <div className="hand-divider" aria-hidden="true" />
          )}
          {myHandCards.map((card) => {
            // 有死牌時只能打死牌（先進先出／聽牌例外由伺服器把關，§7.3）
            const pickable = canDiscard && !hasDead;
            return (
              <Card
                key={card.id}
                card={card}
                selectable={pickable}
                selected={selected === card.id}
                onClick={pickable ? () => setSelected(card.id) : undefined}
              />
            );
          })}
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

      {/* 決定莊家（§4.1）：開局各玩家自己抽牌 */}
      {g.dealerDraw && (
        <DealerDrawPanel
          dealerDraw={g.dealerDraw}
          players={g.players}
          mySeat={mySeat}
          canDraw={canDraw}
          message={g.message}
          onDraw={() => api.act('draw')}
        />
      )}

      {/* 胡牌後手動抽五隻（§9.2）：由胡牌者一張一張抽，符合條件者標記加頭 */}
      {g.drawFive && (
        <DrawFivePanel drawFive={g.drawFive} mySeat={mySeat} onDraw={() => api.act('drawFive')} />
      )}

      {api.gameOver && !api.gameEnded && (
        <RoundResult
          result={api.gameOver}
          players={g.players}
          mySeat={mySeat}
          continueReady={g.continueReady}
          onContinue={api.readyContinue}
          onLeave={api.leave}
        />
      )}

      {/* 斷線暫停遮罩：其他在線玩家等待斷線者重連（斷線者本人看到的是「連線中…」） */}
      {g.paused && !api.gameEnded && (
        <PausedOverlay names={g.disconnectedNames} onEnd={onLeaveClick} />
      )}

      {/* 整場結束：有人離開牌局 → 最終計分版 */}
      {api.gameEnded && <FinalScoreboard result={api.gameEnded} onHome={api.leave} />}
    </div>
  );
}

// 斷線暫停遮罩（§2）：顯示等待重連的玩家；並提供「結束本場」逃生門（避免無限等待）
function PausedOverlay({ names, onEnd }: { names: string[]; onEnd: () => void }) {
  return (
    <div className="overlay paused-overlay">
      <div className="result paused-card">
        <div className="paused-spinner" aria-hidden="true" />
        <h2>遊戲暫停</h2>
        <p className="paused-msg">
          等待
          {names.length > 0 ? <b>「{names.join('、')}」</b> : '玩家'}
          重新連線…
        </p>
        <p className="hint">連線恢復後將自動繼續牌局。</p>
        <button className="btn ghost" onClick={onEnd}>
          結束本場遊戲
        </button>
      </div>
    </div>
  );
}

// 整場結束計分版（§1）：有人離開 → 顯示各家最終累計頭數
function FinalScoreboard({
  result,
  onHome,
}: {
  result: import('@nine-cards/shared').GameEndedPayload;
  onHome: () => void;
}) {
  const top = result.scores.length > 0 ? result.scores[0].total : 0;
  return (
    <div className="overlay ended-overlay">
      <div className="result">
        <h2>牌局結束</h2>
        <div className="result-cat">{result.leaverName} 離開了遊戲</div>
        <table className="score-table">
          <tbody>
            {result.scores.map((s, i) => (
              <tr key={s.seat} className={i === 0 && top > 0 ? 'winner-row' : ''}>
                <td>
                  {i === 0 && top > 0 && '🏆 '}
                  {s.name}
                </td>
                <td className="score-total">{s.total} 頭</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="result-actions">
          <button className="btn primary" onClick={onHome}>
            返回大廳
          </button>
        </div>
      </div>
    </div>
  );
}

// 決定莊家（§4.1）：每位玩家各自摸一張，先比權重（帥/將最大）再比顏色（黃＞紅＞綠＞白）
function DealerDrawPanel({
  dealerDraw,
  players,
  mySeat,
  canDraw,
  message,
  onDraw,
}: {
  dealerDraw: { draws: (CardT | null)[]; contenders: number[]; decidedSeat: number | null };
  players: PublicPlayer[];
  mySeat: number;
  canDraw: boolean;
  message: string | null;
  onDraw: () => void;
}) {
  const nameOf = (seat: number) => players.find((p) => p.seat === seat)?.name ?? `座位${seat}`;
  const seats = [...players].sort((a, b) => a.seat - b.seat);
  const contenders = new Set(dealerDraw.contenders);
  const decided = dealerDraw.decidedSeat; // 已定莊 → 展示三秒
  const iDrew = dealerDraw.draws[mySeat] != null;
  return (
    <div className="overlay">
      <div className="result dealer-draw">
        <h2>抽牌決定莊家</h2>
        <div className="dd-hint">先比大小（帥/將最大），再比顏色（黃＞紅＞綠＞白）</div>
        <div className="dd-rows">
          {seats.map((p) => {
            const card = dealerDraw.draws[p.seat];
            const isDealer = decided === p.seat;
            // 展示定莊時不再淡化落敗者；抽牌途中淘汰者才淡化
            const out = decided == null && !contenders.has(p.seat);
            return (
              <div className={`dd-row ${out ? 'out' : ''} ${isDealer ? 'dealer' : ''}`} key={p.seat}>
                <span className="dd-name">
                  {p.seat === mySeat ? '你' : nameOf(p.seat)}
                  {isDealer && <span className="dd-badge">莊</span>}
                </span>
                {card ? (
                  <Card card={card} small />
                ) : (
                  <div className="dd-placeholder">?</div>
                )}
              </div>
            );
          })}
        </div>
        {decided != null ? (
          <div className="dd-msg">
            {decided === mySeat ? '你' : nameOf(decided)} 當莊！即將發牌…
          </div>
        ) : (
          <>
            {message && <div className="dd-msg">{message}</div>}
            {canDraw ? (
              <button className="btn primary" onClick={onDraw}>
                摸牌
              </button>
            ) : (
              <div className="dd-wait">{iDrew ? '已抽牌，等待其他玩家…' : '請稍候…'}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// 胡牌後手動抽五隻（§9.2）：胡牌者按「抽牌」一張一張抽，符合加頭者高亮標記
function DrawFivePanel({
  drawFive,
  mySeat,
  onDraw,
}: {
  drawFive: DrawFiveView;
  mySeat: number;
  onDraw: () => void;
}) {
  const isWinner = drawFive.winnerSeat === mySeat;
  const whoName = isWinner ? '你' : drawFive.winnerName;
  const qualified = drawFive.entries.filter((e) => e.qualifying).length;
  return (
    <div className="overlay">
      <div className="result draw-five-panel">
        <h2>抽五隻</h2>
        <div className="df-hint">
          {whoName} 胡「{drawFive.winningCard.color}
          {drawFive.winningCard.rank}」，抽五張；抽中同種即加頭
        </div>
        <div className="df-progress">
          已抽 {drawFive.drawn} / {drawFive.total}　中 {qualified} 張
        </div>
        <div className="df-cards">
          {drawFive.entries.map((e, i) => (
            <div className={`df-slot ${e.qualifying ? 'hit' : ''}`} key={e.card.id + i}>
              <Card card={e.card} small />
              {e.qualifying && <span className="df-badge">＋{e.heads}</span>}
            </div>
          ))}
          {/* 尚未抽出的位置以佔位框顯示 */}
          {Array.from({ length: Math.max(0, drawFive.total - drawFive.drawn) }).map((_, i) => (
            <div className="df-slot empty" key={`e${i}`}>
              <div className="df-placeholder">?</div>
            </div>
          ))}
        </div>
        {drawFive.canDraw ? (
          <button className="btn primary" onClick={onDraw}>
            抽一張
          </button>
        ) : (
          <div className="df-wait">
            {isWinner ? '抽牌完成，計分中…' : `等待 ${drawFive.winnerName} 抽牌…`}
          </div>
        )}
      </div>
    </div>
  );
}

// 一局結算：胡牌方式、頭數明細、抽五隻揭示、各家累計分數
function RoundResult({
  result,
  players,
  mySeat,
  continueReady,
  onContinue,
  onLeave,
}: {
  result: GameOverPayload;
  players: PublicPlayer[];
  mySeat: number;
  continueReady: number[];
  onContinue: () => void;
  onLeave: () => void;
}) {
  const nameOf = (seat: number) => players.find((p) => p.seat === seat)?.name ?? `座位${seat}`;
  const deltaOf = (seat: number) =>
    result.payments.find((p) => p.seat === seat)?.delta ?? 0;
  const rows =
    result.scores.length > 0
      ? result.scores
      : players.map((p) => ({ seat: p.seat, total: p.score }));

  return (
    // result-overlay：面板靠上顯示，避免擋住下方手牌
    <div className="overlay result-overlay">
      <div className="result">
        <h2>
          {result.reason === 'draw' ? '流局（原莊連任）' : `${result.winnerName ?? ''} 胡牌！`}
        </h2>

        {result.reason === 'win' && (
          <>
            <div className="result-cat">{result.category}｜共 {result.heads} 頭</div>
            <div className="result-breakdown">
              {result.breakdown.color === 0
                ? '四色 → 0 頭（不加頭、不抽五隻）'
                : `顏色 ${result.breakdown.color}`}
              {result.breakdown.selfDraw > 0 && ` ＋ 自摸 ${result.breakdown.selfDraw}`}
              {result.breakdown.huKai > 0 && ` ＋ 胡開 ${result.breakdown.huKai}`}
              {result.breakdown.drawFive > 0 && ` ＋ 抽五隻 ${result.breakdown.drawFive}`}
            </div>
            {result.drawFive && (
              <div className="result-drawfive">
                <div className="rd-label">抽五隻（中 {result.drawFive.qualifying} 張）</div>
                <div className="rd-cards">
                  {result.drawFive.cards.map((card, i) => (
                    <div className={`df-slot ${result.drawFive!.marks[i] ? 'hit' : ''}`} key={card.id + i}>
                      <Card card={card} small />
                      {result.drawFive!.marks[i] && <span className="df-badge">加頭</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <table className="score-table">
          <tbody>
            {rows.map((s) => {
              const d = deltaOf(s.seat);
              const pl = players.find((p) => p.seat === s.seat);
              const ready = continueReady.includes(s.seat);
              return (
                <tr key={s.seat}>
                  <td>{nameOf(s.seat)}</td>
                  {/* 標記誰按了「繼續」，一眼看出還在等誰 */}
                  <td className="ready-cell">
                    {pl && !pl.connected ? (
                      <span className="ready-no">斷線</span>
                    ) : ready ? (
                      <span className="ready-yes">✓ 已準備</span>
                    ) : (
                      <span className="ready-no">等待中…</span>
                    )}
                  </td>
                  <td className={d > 0 ? 'up' : d < 0 ? 'down' : ''}>
                    {d > 0 ? `+${d}` : d}
                  </td>
                  <td className="score-total">{s.total} 頭</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {result.nextDealerSeat != null && (
          <div className="result-next">下一局莊家：{nameOf(result.nextDealerSeat)}</div>
        )}

        {/* §13：全員按「繼續」才開下一局，否則停留在結算畫面 */}
        <div className="result-ready">
          已準備 {continueReady.length} / {players.filter((p) => p.connected).length} 人
        </div>
        <div className="result-actions">
          {continueReady.includes(mySeat) ? (
            <button className="btn primary" disabled>
              已準備，等待其他玩家…
            </button>
          ) : (
            <button className="btn primary" onClick={onContinue}>
              繼續下一局
            </button>
          )}
          <button className="btn" onClick={onLeave}>
            離開
          </button>
        </div>
      </div>
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
        {p.isTenpai && <span className="tenpai-badge">聽</span>}
        {p.isXianggong && <span className="xg-badge">相公</span>}
        <span className="opp-score">{p.score} 頭</span>
        {!p.connected && ' 📴'}
      </div>
      {/* 公開區（吃牌對子＋死牌單張）＋分隔線＋暗牌，同一列；死牌以單張未成對表示 */}
      <div className="opp-row">
        {(p.melds.length > 0 || p.deadCards.length > 0) && (
          <>
            <div className="opp-melds">
              {p.melds.map((pair, i) => (
                <div className="meld" key={`m${i}`}>
                  {pair.map((card) => (
                    <Card key={card.id} card={card} small />
                  ))}
                </div>
              ))}
              {p.deadCards.map((card) => (
                <div className="dead-single" key={card.id}>
                  <Card card={card} small />
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
