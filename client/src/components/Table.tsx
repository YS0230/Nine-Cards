import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameApi } from '../useGame.js';
import { Card } from './Card.js';
import { ChatPanel } from './ChatPanel.js';
import { Scene3D } from '../three/Scene3D.js';
import { playCardVoice, playEffect } from '../sound.js';
import { moneyIconUrl } from '../money.js';
import type {
  PublicPlayer,
  Card as CardT,
  GameOverPayload,
  DrawFiveView,
  StandeeStyle,
} from '@nine-cards/shared';

const LS_VIEW3D = 'nineCards.view3d';
const LS_STANDEE_STYLE = 'nineCards.standeeStyle';
// 玩家人形立牌畫風：比照 2D/3D 切換鈕，純本地顯示設定（不送伺服器），依序循環
const STANDEE_STYLE_CYCLE: StandeeStyle[] = ['qb', 'g7', '3d'];
const STANDEE_STYLE_LABEL: Record<StandeeStyle, string> = { qb: '去背', g7: 'G7', '3d': '3D立牌' };

export function Table({ api }: { api: GameApi }) {
  const g = api.game!;
  const [selected, setSelected] = useState<string | null>(null);
  // 3D 牌桌（three.js）／傳統 2D 版面切換，記住玩家選擇
  const [view3d, setView3d] = useState(() => localStorage.getItem(LS_VIEW3D) !== '0');
  const toggleView = () => {
    setView3d((v) => {
      localStorage.setItem(LS_VIEW3D, v ? '0' : '1');
      return !v;
    });
  };
  // 對手人形立牌畫風（去背／G7／3D 模型），記住玩家選擇
  const [standeeStyle, setStandeeStyle] = useState<StandeeStyle>(
    () => (localStorage.getItem(LS_STANDEE_STYLE) as StandeeStyle | null) ?? 'qb',
  );
  const cycleStandeeStyle = () => {
    setStandeeStyle((s) => {
      const next = STANDEE_STYLE_CYCLE[(STANDEE_STYLE_CYCLE.indexOf(s) + 1) % STANDEE_STYLE_CYCLE.length];
      localStorage.setItem(LS_STANDEE_STYLE, next);
      return next;
    });
  };

  const mySeat = g.you.seat;
  const seatCount = g.players.length;
  // 逆時鐘輪替：我到對方的輪替距離（1＝下家、n-1＝上家）
  const turnDist = (seat: number) => (mySeat - seat + seatCount) % seatCount;
  // 排列如實體牌桌視角：左＝上家、中＝對家、右＝下家（距離大→小）
  const opponents = g.players
    .filter((p) => p.seat !== mySeat)
    .sort((a, b) => turnDist(b.seat) - turnDist(a.seat));
  const me = g.players.find((p) => p.seat === mySeat);
  const myScore = me?.score ?? 0;
  const myMoney = me?.money ?? 0;
  const myTenpai = me?.isTenpai ?? false;
  const myXianggong = me?.isXianggong ?? false; // 相公：本局僅能觀看
  const deadIdSet = new Set(g.you.deadIds); // 我的死牌 id（出牌時須先出，§7.3）
  const hasDead = deadIdSet.size > 0;
  // 死牌移到公開區顯示（依 FIFO 順序）；暗手牌只留非死牌
  const myDeadCards = g.you.deadIds
    .map((id) => g.you.hand.find((c) => c.id === id))
    .filter((c): c is CardT => !!c);
  const myHandCards = g.you.hand.filter((c) => !deadIdSet.has(c.id));
  // 此刻真正可打出的死牌（伺服器算好的先進先出結果；兩張死牌且例外成立時可能有兩張）
  const forcedIds = g.you.forcedDiscardIds;
  const forcedCards = forcedIds
    ? myDeadCards.filter((c) => forcedIds.includes(c.id))
    : [];
  const forcedNames = forcedCards.map((c) => `${c.color}${c.rank}`).join('、');
  const canDiscard = g.legalActions.includes('discard');
  const canDraw = g.legalActions.includes('draw');
  const canEat = g.legalActions.includes('eat');
  const canWin = g.legalActions.includes('declareWin');
  const canPass = g.legalActions.includes('pass'); // 自摸保護：可「不吃」打出摸到的牌
  const myTurn = g.currentTurnSeat === mySeat;
  const turnName = g.players.find((p) => p.seat === g.currentTurnSeat)?.name ?? '';
  const nameOf = (seat: number) =>
    seat === mySeat ? '你' : (g.players.find((p) => p.seat === seat)?.name ?? `座位${seat}`);
  // 相對位置標示（逆時鐘換人 → 輪替距離 1＝下家、n-1＝上家）：
  // 兩人＝對家；三人＝上、下家；四人＝上、對、下家
  const relationOf = (seat: number): string => {
    if (seatCount === 2) return '對家';
    const d = turnDist(seat);
    if (d === 1) return '下家';
    if (d === seatCount - 1) return '上家';
    return '對家';
  };
  // 3D 牌桌對手資訊疊層：固定貼在畫面邊緣（下家右／上家左／對家上），不隨鏡頭位置變化
  const zoneOf = (seat: number): 'left' | 'right' | 'top' => {
    if (seatCount === 2) return 'top';
    const d = turnDist(seat);
    if (d === 1) return 'right';
    if (d === seatCount - 1) return 'left';
    return 'top';
  };
  // 新手提示關閉：吃/胡按鈕不自動鎖定（相公、對局結束除外），按下後由伺服器判定
  const eatEnabled = g.hints ? canEat : !myXianggong && g.phase === 'PLAYING';
  const winEnabled = g.hints ? canWin : !myXianggong && g.phase === 'PLAYING';

  // 3D 場景：此刻可點選的牌 id（規則與 2D 相同：有死牌只能點強制打出的那張）
  const pickableIds = useMemo(() => {
    const ids = new Set<string>();
    if (!canDiscard) return ids;
    if (hasDead) {
      for (const id of forcedIds ?? []) ids.add(id);
    } else {
      for (const c of myHandCards) ids.add(c.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

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
  // 上一次全桌死牌 id 快照：用來判斷新出現在棄牌區的牌「原本是不是死牌」（打出死牌要額外提示音）
  const prevDeadIds = useRef(
    new Set<string>([...g.you.deadIds, ...g.players.flatMap((p) => p.deadCards.map((c) => c.id))]),
  );

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

    // ── 動作音效：吃／聽／胡（自摸另用專屬音效）／打出死牌（與報牌共用播放佇列，依序不疊音）──
    if (g.winnerSeat != null && prevWinner.current == null) {
      void playEffect(g.winnerSelfDraw ? 'selfDrawWin' : 'win');
    }
    prevWinner.current = g.winnerSeat;
    for (const p of g.players) {
      if (p.isTenpai && !prevTenpai.current.get(p.seat)) void playEffect('tenpai'); // 新聽牌
      prevTenpai.current.set(p.seat, p.isTenpai);
    }
    // 死牌先進先出（§7.3）：新落入棄牌區的牌，若打出前就是死牌 → 額外播放提示音
    for (const c of g.discardPile.slice(prevDiscardLen.current)) {
      if (prevDeadIds.current.has(c.id)) void playEffect('deadCard');
    }
    prevDeadIds.current = new Set([
      ...g.you.deadIds,
      ...g.players.flatMap((p) => p.deadCards.map((c) => c.id)),
    ]);
    let card: CardT | null = null;
    let label = '翻牌';
    // 吃牌（含被更高優先者搶吃）以「座位+牌」為鍵，換人吃同一張也會再跳一次
    const eatKey = g.eating ? `${g.eating.seat}:${g.eating.card.id}` : null;
    if (eatKey && eatKey !== prevEatKey.current) {
      // 死牌就地湊對（§7.2）→ 播「撿」；一般吃牌（含被高優先者搶吃）→ 播「吃」
      void playEffect(g.eating!.matchedDeadCard ? 'pickupDead' : 'eat');
    }
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

  // ── 聊天：收合面板（header 聊天鈕＋未讀數）＋ 新訊息在對應玩家旁短暫顯示氣泡 ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatRead, setChatRead] = useState(api.chat.length); // 已讀到第幾則
  useEffect(() => {
    if (chatOpen) setChatRead(api.chat.length); // 面板開著 → 隨時視為已讀
  }, [chatOpen, api.chat.length]);
  const unread = chatOpen ? 0 : Math.max(0, api.chat.length - chatRead);
  // 對話氣泡：只顯示最新一則，4 秒後消失（比照 reveal 翻牌層做法）
  const [bubble, setBubble] = useState<{ seat: number; text: string } | null>(null);
  const prevChatLen = useRef(api.chat.length);
  const bubbleTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (api.chat.length > prevChatLen.current) {
      const m = api.chat[api.chat.length - 1];
      // CHAT_HISTORY 整段補發（重連）也會讓長度增加：只有「剛剛」的訊息才跳氣泡
      if (Date.now() - m.ts < 3000) {
        setBubble({ seat: m.seat, text: m.text });
        window.clearTimeout(bubbleTimer.current);
        bubbleTimer.current = window.setTimeout(() => setBubble(null), 4000);
      }
    }
    prevChatLen.current = api.chat.length;
  }, [api.chat]);
  useEffect(() => () => window.clearTimeout(bubbleTimer.current), []);

  // 輪到你浮層提示：輪到你且尚未摸牌時，等 1 秒還沒摸才顯示；摸完牌（canDraw 變 false）就收起
  const [showTurnBanner, setShowTurnBanner] = useState(false);
  const turnStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (myTurn && canDraw) {
      const t = window.setTimeout(() => {
        turnStartRef.current = Date.now();
        setShowTurnBanner(true);
      }, 1000);
      return () => window.clearTimeout(t);
    }
    setShowTurnBanner(false);
    turnStartRef.current = null;
  }, [myTurn, canDraw]);

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

  // 提示關閉時不揭露「你可以吃/胡」，僅提示視窗開著、由玩家自行判斷
  const prompt = myXianggong
    ? '你已相公（逾時未吃），本局僅能觀看'
    : g.hints && canWin
    ? '你可以胡牌！'
    : canPass
      ? '自摸！可吃請按「吃」，不吃就點中央那張打出'
      : g.hints && canEat
        ? '有人出牌，要吃請按「吃」'
        : canDraw
          ? g.pendingClaim
            ? '不吃的話，按「摸牌」換你'
            : '輪到你，請摸牌'
          : canDiscard
            ? hasDead
              ? forcedCards.length > 1
                ? `手上有死牌，可任選一張打出：${forcedNames}`
                : `手上有死牌，需先打出「${forcedNames}」（死牌先進先出）`
              : selected
                ? '按「打出」送出這張牌'
                : '點選一張要打出的牌'
            : !g.hints && g.pendingClaim
              ? '要吃／胡請自行按按鈕，由系統判定'
              : `等待 ${turnName} 行動…`;

  return (
    <div className="table">
      <header className="table-top">
        <span className="chip">房 {api.room?.code ?? g.roomId.slice(0, 4)}</span>
        <span className="chip">牌堆 {g.deckCount}</span>
        <span className="chip">
          我 {myScore} 頭{myTenpai && ' · 聽'}
          {myXianggong && <span className="xg-badge">相公</span>}
          <span className="my-money">
            <img className="money-icon" src={moneyIconUrl(myMoney)} alt="" />
            {myMoney} 元
          </span>
        </span>
        <span className={`chip turn ${myTurn ? 'me' : ''}`}>
          {myTurn ? '輪到你' : `輪到 ${turnName}`}
        </span>
        <button className="chip chat-chip" onClick={() => setChatOpen((o) => !o)} aria-label="聊天">
          💬
          {unread > 0 && <span className="chat-chip-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="chip" onClick={toggleView}>
          {view3d ? '2D' : '3D'}
        </button>
        {view3d && (
          <button className="chip" onClick={cycleStandeeStyle} title="切換對手立牌畫風">
            立牌：{STANDEE_STYLE_LABEL[standeeStyle]}
          </button>
        )}
        <button className="chip leave-chip" onClick={onLeaveClick}>
          離開
        </button>
      </header>

      {showTurnBanner && turnStartRef.current != null && <TurnBanner startedAt={turnStartRef.current} />}

      {view3d ? (
        /* 3D 牌桌（three.js）：手牌/對手/棄牌/牌堆全在場景內，點牌選牌 */
        <section className="scene3d-wrap">
          <Scene3D
            g={g}
            selectedId={selected}
            pickableIds={pickableIds}
            canPass={canPass}
            standeeStyle={standeeStyle}
            onPick={setSelected}
            onPass={() => api.act('pass')}
          />
          {/* 對手資訊：固定 HTML 疊層，貼在畫面邊緣，不隨 3D 鏡頭透視變化 */}
          <div className="s3-badges">
            {opponents.map((p) => (
              <div
                key={p.id}
                className={`s3-badge s3-badge-${zoneOf(p.seat)} ${
                  p.seat === g.currentTurnSeat ? 'active' : ''
                }`}
              >
                <span className="rel-badge">{relationOf(p.seat)}</span>
                {p.isDealer && '👑 '}
                {p.name}
                {p.isTenpai && <span className="tenpai-badge">聽</span>}
                {p.isXianggong && <span className="xg-badge">相公</span>}
                <span className="opp-score">{p.score} 頭</span>
                {!p.connected && ' 📴'}
                {bubble?.seat === p.seat && <div className="chat-bubble s3-bubble">{bubble.text}</div>}
              </div>
            ))}
          </div>
          {/* 待吃牌／吃牌中：文字說明與倒數條用 DOM 疊在場景上方 */}
          {g.pendingClaim && (
            <div className={`s3-offer ${canPass ? 'selfeat' : ''}`}>
              <div className="co-label">
                {canPass
                  ? '你自摸這張（不限時）：不吃 → 點中央那張打出'
                  : `${g.players.find((p) => p.seat === g.pendingClaim!.fromSeat)?.name} 的這張，可吃／胡`}
              </div>
              {g.claimEndsAt && <CountdownBar endsAt={g.claimEndsAt} total={g.claimWindowMs} />}
            </div>
          )}
          {!g.pendingClaim && g.eating && (
            <div className="s3-offer eaten">
              <div className="co-label">
                {nameOf(g.eating.seat)} 吃了這張，
                {g.eating.seat === mySeat ? '請打出一張牌' : `等待 ${nameOf(g.eating.seat)} 出牌…`}
              </div>
            </div>
          )}
          {g.message && <div className="msg s3-msg">{g.message}</div>}
        </section>
      ) : (
        <>
          <section className="opponents">
            {opponents.map((p) => (
              <OpponentSeat
                key={p.id}
                p={p}
                relation={relationOf(p.seat)}
                active={p.seat === g.currentTurnSeat}
                bubbleText={bubble?.seat === p.seat ? bubble.text : undefined}
              />
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
                  {g.claimEndsAt && <CountdownBar endsAt={g.claimEndsAt} total={g.claimWindowMs} />}
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
        </>
      )}

      {/* 聊天浮動面板：掛在 .table 層（2D/3D 共用），貼在手牌區上方 */}
      {chatOpen && (
        <ChatPanel
          messages={api.chat}
          myPlayerId={api.identity?.playerId ?? null}
          onSend={api.sendChat}
          onClose={() => setChatOpen(false)}
        />
      )}

      {/* 我的區域：固定高度，melds 保留空間、動作列固定不跳動 */}
      <section className="me">
        {/* 自己的聊天氣泡：絕對定位在手牌區上緣，不佔版面 */}
        {bubble?.seat === mySeat && <div className="chat-bubble me-bubble">{bubble.text}</div>}
        {/* 公開區（吃牌對子＋死牌單張）｜分隔線｜暗手牌，同一列、同尺寸、依寬度自動縮放
            （3D 模式下手牌畫在場景裡，這一列不顯示） */}
        {!view3d && (
          <div className="hand-row" aria-label="我的公開區與手牌">
            {g.you.melds.map((pair, i) => (
              <div className="meld" key={`m${i}`}>
                {pair.map((card) => (
                  <Card key={card.id} card={card} />
                ))}
              </div>
            ))}
            {/* 死牌：公開區中的單張（未成對即為死牌，§7.2）。
                先進先出：只有伺服器判定「此刻可打出」的那張（forcedDiscardIds）才能選，
                其餘死牌先鎖住，避免玩家選錯順序卻收到看不出原因的錯誤訊息 */}
            {myDeadCards.map((card) => {
              const isForced = forcedIds?.includes(card.id) ?? false;
              const pickable = canDiscard && isForced;
              return (
                <div
                  className={`dead-single ${hasDead && !isForced ? 'locked' : ''}`}
                  key={card.id}
                >
                  <Card
                    card={card}
                    selectable={pickable}
                    selected={selected === card.id}
                    onClick={pickable ? () => setSelected(card.id) : undefined}
                  />
                  {hasDead && isForced && forcedCards.length < myDeadCards.length && (
                    <span className="dead-next-badge">先出</span>
                  )}
                </div>
              );
            })}
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
        )}

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
          <button className="btn act" disabled={!eatEnabled} onClick={() => api.act('eat')}>
            吃
          </button>
          <button className="btn win act" disabled={!winEnabled} onClick={() => api.act('declareWin')}>
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
                <td className="score-money">{s.money} 元</td>
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
          {drawFive.winningCard.rank}」，抽五張；抽中與胡牌牌組同種即加頭
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

// 顏色種數（1~4）轉顯示用「x色」（§11）
const colorCountLabel = (count: number) => `${['', '一', '二', '三', '四'][count] ?? count}色`;

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
  // 胡牌者牌組（伺服器已依牌種排序）→ 兩張一組顯示五對；胡的那張加標記
  const winnerPairs: CardT[][] = [];
  if (result.winnerHand) {
    for (let i = 0; i < result.winnerHand.length; i += 2) {
      winnerPairs.push(result.winnerHand.slice(i, i + 2));
    }
  }
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
            {/* 胡牌者的完整牌組（五對）；胡的那張以「胡」標記 */}
            {winnerPairs.length > 0 && (
              <div className="result-hand">
                {winnerPairs.map((pair, i) => (
                  <div className="result-pair" key={`wp${i}`}>
                    {pair.map((card) => (
                      <div
                        className={`df-slot ${card.id === result.winningCard?.id ? 'hit' : ''}`}
                        key={card.id}
                      >
                        <Card card={card} small />
                        {card.id === result.winningCard?.id && (
                          <span className="df-badge">胡</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="result-breakdown">
              {result.breakdown.color === 0
                ? '四色 → 0 頭（不加頭、不抽五隻）'
                : `${colorCountLabel(result.breakdown.colorCount)} ${result.breakdown.color}頭`}
              {result.breakdown.selfDraw > 0 && ` ＋ 自摸 ${result.breakdown.selfDraw}頭`}
              {result.breakdown.huKai > 0 && ` ＋ 胡開 ${result.breakdown.huKai}頭`}
              {result.breakdown.drawFiveFront > 0 &&
                ` ＋ 對花 ${result.breakdown.drawFiveFront}頭`}
              {result.breakdown.drawFiveLast > 0 &&
                ` ＋ 尾椎 ${result.breakdown.drawFiveLast}頭`}
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
                  <td className="score-money">{pl?.money ?? 0} 元</td>
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

// 輪到你浮層提示：彈跳動畫 + 隨經過時間慢慢放大（有上限，避免無限長大跑版）
function TurnBanner({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const elapsed = (now - startedAt) / 1000;
  const scale = Math.min(1.6, 1 + elapsed * 0.04);
  return (
    <div className="turn-banner" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
      輪到你了！
    </div>
  );
}

// 吃牌時間窗倒數條：從剩餘時間縮到 0，讓玩家知道要在時間內決定
function CountdownBar({ endsAt, total }: { endsAt: number; total: number }) {
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
  const remain = Math.max(0, endsAt - now);
  const pct = Math.min(100, (remain / total) * 100);
  return (
    <div className="countdown">
      <div className="countdown-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function OpponentSeat({
  p,
  relation,
  active,
  bubbleText,
}: {
  p: PublicPlayer;
  relation: string; // 相對位置：上家／對家／下家
  active: boolean;
  bubbleText?: string; // 這位玩家剛說的話（短暫顯示的對話氣泡）
}) {
  return (
    <div className={`opp ${active ? 'active' : ''}`}>
      {bubbleText && <div className="chat-bubble opp-bubble">{bubbleText}</div>}
      <div className="opp-head">
        <span className="rel-badge">{relation}</span>
        {p.isDealer && '👑 '}
        {p.name}
        {p.isTenpai && <span className="tenpai-badge">聽</span>}
        {p.isXianggong && <span className="xg-badge">相公</span>}
        <span className="opp-score">{p.score} 頭</span>
        <span className="opp-money">
          <img className="money-icon" src={moneyIconUrl(p.money)} alt="" />
          {p.money} 元
        </span>
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
