# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

九支仔 (Nine Cards) — a real-time, mobile-first multiplayer web game of a Mahjong-like
matching card game. The authoritative game rules live in `game rule.md` (Traditional Chinese);
read it before touching game logic. The implementation is an **MVP**: connect → deal → draw →
discard → eat → win-on-five-pairs works end to end. Advanced rules noted in `game rule.md`
(dead cards 死牌, tenpai announce 聽牌, draw-five 抽五隻, 胡開, color scoring, 一炮多響,
流局 dealer-continue) are intentionally **not implemented yet** — the engine leaves extension
points for them.

## Commands

Run from the repo root (npm workspaces monorepo):

```bash
npm install
# If native install scripts (sharp / esbuild) are blocked by allow-scripts:
npm approve-scripts esbuild && npm approve-scripts sharp
npm run slice            # REQUIRED once: slices Sprite Sheet.png → client/public/cards/*.png (28 faces)

npm run dev              # runs server (:3001) + client (:5173) together
npm run dev:server       # server only (tsx watch)
npm run dev:client       # client only (vite, host:true so LAN phones can connect)

npm test                 # engine unit tests (vitest, server workspace)
npm run test --workspace server -- -t "自摸"   # run a single test by name substring
npm run typecheck --workspace server           # tsc --noEmit
npx tsc -p client/tsconfig.json --noEmit       # typecheck client (no script for it)
npm run build --workspace client               # production build (also catches client compile errors)
```

`client/public/cards/` is gitignored and must be regenerated with `npm run slice` after a fresh
clone (the sprite sheet is 960×494, a 2×2 grid of color blocks → 28 ASCII-named faces like
`y0.png`=黃帥, `w6.png`=白卒).

## Architecture

Three workspaces, all TypeScript ESM. The design principle is an **authoritative server**: the
client never holds authority — it renders whatever personalized view the server sends and issues
action requests the server validates.

- **`shared/`** — types + rule primitives used by both server and client. This is a
  **source-only package** (`main`/`exports` point at `src/index.ts`, no build step); both `tsx`
  (server) and Vite (client) transpile it directly. `cards.ts` holds the deck model and pure rule
  helpers (`buildDeck`, `isPair`, `isWinningSet`, `countPairs`, `cardImageBase`); `types.ts` holds
  the wire view-models; `events.ts` holds the `EVT` Socket.IO event-name constants and payloads.
  Authoritative game logic does **not** live here (clients can read it) — only pure, cheat-safe
  primitives.

- **`server/`** — Node + Express + Socket.IO. Two layers:
  - `game/engine.ts` (`GameEngine`) is the authoritative state machine for a single hand. All
    mutation goes through `apply(playerId, action, cardId?)`, gated by `legalActionsFor(seat)`.
    `viewFor(playerId)` produces a **per-player redacted `PersonalGameState`** — you get your own
    `hand`, opponents give only `handCount` + public melds. When adding state, never leak other
    players' concealed cards through `viewFor`.
  - `game/gameServer.ts` (`GameServer`) owns rooms, matchmaking (private code + public lobby +
    quick match), player identity/reconnect tokens, and the claim-window timer. It has **no socket
    access**: `index.ts` injects a broadcaster via `setBroadcaster` and does all `io.emit`ing.
  - `index.ts` wires Socket.IO events → `GameServer` methods, then calls `pushState(room)` which
    sends `ROOM_UPDATE` (lobby) or personalized `GAME_STATE` per connected player. In-memory state
    only (no DB); rooms keyed in `Map`s.

- **`client/`** — React 18 + Vite, mobile-first (portrait, fixed-region layout that must not
  reflow). `useGame.ts` is the single socket hook holding all state and exposing action senders;
  `App.tsx` routes between `Lobby` / `WaitingRoom` / `Table` on `screen`. The client trusts
  `game.legalActions` to enable/disable the fixed action bar — do not re-derive legality
  client-side. Connects to `VITE_SERVER_URL` or `http://<hostname>:3001`.

### Turn / claim model (the subtle part)

The engine stage machine is `DRAW → CLAIM → EATING → DISCARD`. A drawn or discarded card opens a
**claim window** only if someone can eat/hu it (otherwise it goes straight to the discard pile and
the turn advances). Key rules encoded in `engine.ts` — preserve them when editing:

- Eat is **tentative until the eater discards**: a higher-priority eligible player can still `eat`
  to bump a lower-priority holder (who yields, meld reverted). Priority = hu > eat, then 下家優先
  (clockwise distance), captured in `claimOrder`.
- The **next player may only `draw` after `CLAIM_WINDOW_MS` (default 2000ms, `CLAIM_WINDOW_MS`
  env override) AND no one has claimed**; drawing then closes the window (unclaimed card → discard).
  A server timer (`GameServer.scheduleClaim`) only re-pushes state at the window end to enable that
  draw button — it does **not** auto-resolve.
- **Self-draw protection (`protectedSelfEat`)**: if the drawer can **hu** their own drawn card
  (highest priority — even when other players are also waiting on that same card), or can **eat**
  it while no *other* player can hu it, the window is unlimited (`claimEndsAt = MAX_SAFE_INTEGER`),
  the next player is blocked from drawing, and only the drawer acts — `declareWin`, `eat`, or
  `pass` (decline → remaining claimers get a timed window; if none, the drawn card is discarded).
  `pass` is a legal action *only* in this case (there is deliberately no general "pass" button in
  the UI).
- During `EATING`, `viewFor` exposes `eating: { seat, card }` so every client shows who ate which
  card while the eater picks a discard.

## Conventions

- Comments and user-facing strings are Traditional Chinese; match that when editing.
- Cross-file/workspace imports use explicit `.js` extensions on `.ts` files (NodeNext-style;
  resolved by tsx/Vite/Vitest). Keep this style.
- After changing the engine, run `npm test` and prefer driving a full game over a socket to catch
  integration issues (races around the claim window are expected and correctly rejected with
  「現在無法執行此動作」/「優先權不足」).
