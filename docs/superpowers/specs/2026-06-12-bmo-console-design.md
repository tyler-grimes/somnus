# BMO Console — Interactive Somnus + Gruvbox 8-bit Dashboard

**Date:** 2026-06-12
**Status:** Approved by Tyler (brainstorming session "somnus")
**Goal:** Redesign the web console as a gruvbox-dark, 8-bit scene with a BMO
(Adventure Time) at center whose screen is a **live chat terminal you can send
messages to Somnus from**, surrounded by reskinned terminal windows showing the
same live data as today.

## Decisions (brainstorming)

| Decision | Choice |
|---|---|
| Web→agent transport | DB handoff via a `web_chat` table in the shared Postgres (no new inbound port on the agent) |
| Chat auth | Shared token (VM `.env`) + tailnet. Read windows stay open; **sending** a message requires the token, which the user enters in BMO (localStorage, sent as a header) — never injected into the page |
| Session | Shared with Telegram — all turns go through `runAgentTurn`'s single session, serialized by a mutex |
| Look | Gruvbox dark, 8-bit/pixel, BMO center, PostHog-playful terminal cards |

## 1. Web ↔ Somnus chat path

**Schema** — `db/init/004_web_chat.sql`:
```sql
CREATE TABLE IF NOT EXISTS web_chat (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt      TEXT NOT NULL,
  reply       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS web_chat_pending_idx ON web_chat (created_at) WHERE status = 'pending';
```
Applied automatically by the existing `migrate` service.

**Dashboard endpoints** (`dashboard/server.ts`):
- `POST /api/chat` — body `{ text }`, header `x-somnus-token`. If `CHAT_TOKEN` is
  set in the dashboard env and the header doesn't match → `401`. Insert a
  `pending` row, return `{ id }`. Reject empty/oversized text (cap ~4000 chars).
- `GET /api/chat/:id` — return `{ status, reply }` for polling.
- `GET /api/chat/history` — last ~20 `web_chat` rows (both prompt + reply) for
  initial render. (Read-only, no token — consistent with the other read APIs.)

**Agent poller** (`agent/src/webchat.ts`, started from `index.ts`):
- Every 2s, `SELECT ... FROM web_chat WHERE status='pending' ORDER BY created_at LIMIT 1`.
- For the claimed row, call the **serialized** turn runner with
  `runAgentTurn(prompt, "web")`; on success write `reply`, `status='done'`,
  `answered_at=now()`; on throw write the error message + `status='error'`.
- Claim safely with `UPDATE web_chat SET status='running' WHERE id=$1 AND status='pending' RETURNING *` so a row is processed once even if polls overlap.

**Serialized turn runner** (`agent/src/agent.ts`):
- Add `"web"` to `runAgentTurn`'s `source` union.
- Add a module-level single-flight mutex (a promise chain) wrapping turn
  execution. Both the Telegram handler and the web poller acquire it, so two
  turns never run concurrently against the shared SDK session. Export a
  `runTurnExclusive(text, source)` helper; the Telegram handler switches to it
  (still off the grammY update loop — the existing no-block gotcha holds).

**Security carried over (no new code):** a web turn's tool calls still pass
through `decidePermission` → Telegram approval, and `spentTodayUsd()` /
`dailySpendLimitUsd` still gate it. So an unlocked chat cannot silently run Bash
or exceed the daily cap. Token + tailnet bound *who can initiate*; the existing
gates bound *what a turn can do*.

## 2. Aesthetic — gruvbox 8-bit

**Palette (gruvbox dark):** bg `#282828` / hard `#1d2021`, fg `#ebdbb2`,
gray `#928374`; accents red `#fb4934`, green `#b8bb26`, yellow `#fabd2f`,
blue `#83a598`, purple `#d3869b`, aqua `#8ec07c`, orange `#fe8019`.

**8-bit treatment:** chunky 2–3px hard borders, offset block drop-shadows (no
blur), faint scanline overlay, `image-rendering:pixelated`, blocky monospace
with letter-spacing; pixel-art built from CSS (no external font CDN — the box is
tailnet-only and should not depend on the public internet).

## 3. BMO (center)

- CSS pixel-art: teal-green body, D-pad + red/green/blue/yellow buttons, a slot,
  little legs/arms — recognizably BMO without copying art assets.
- **BMO's screen IS the chat terminal:** a scrolling message log (you → Somnus,
  Somnus → you) and an input line. Enter sends; if `CHAT_TOKEN` is required and
  not yet unlocked, the first send shows a one-line token prompt (stored in
  localStorage, sent as `x-somnus-token`).
- **Reactive face:** idle blink; "thinking" eyes (a spinner/`…`) while a turn is
  `pending`/`running`; content mouth on reply; mood label tied to the scheduler
  state — `awake` / `dreaming` (dream-cycle active) / `resting` (00:00–06:00).
- BMO is fixed at center (the previous orb + tendrils are removed).

## 4. Terminal windows (the five data feeds)

- Same five — memory, episodes, sessions, spend, scheduler — same live data and
  endpoints as the current console, same **draggable / resizable / focus /
  localStorage-persisted** behavior.
- Reskinned as gruvbox "terminal cards": titlebar with a pixel label + colored
  dots, monospace body, hard borders + block shadow. PostHog-playful touches:
  bold section headers, characterful empty states. No connecting tendrils.

## 5. Files

- Create: `db/init/004_web_chat.sql`, `agent/src/webchat.ts`.
- Modify: `agent/src/agent.ts` (add `"web"` source + exclusive turn runner),
  `agent/src/index.ts` (start the poller), `agent/src/telegram.ts` (use the
  exclusive runner), `dashboard/server.ts` (chat endpoints + `CHAT_TOKEN`),
  `dashboard/public/index.html` (full rewrite), `.env.example` (`CHAT_TOKEN`),
  `docker-compose.yml` (pass `CHAT_TOKEN` to the dashboard service).

## 6. Error handling

- DB unreachable in the poller → log, leave row `pending` for the next tick
  (don't lose it).
- Turn throws → row `status='error'`, reply = the error text; BMO shows it
  plainly (consistent with the "surface real errors" rule).
- Mac/agent offline or poller not running → page shows the message "queued"
  state; if no reply after a timeout (~90s) BMO says so. No fake replies.
- Bad/missing token on `POST /api/chat` → `401`; BMO shows "locked — enter token".

## 7. Verification

- Migration applies (`web_chat` exists).
- `POST /api/chat` without token (when set) → 401; with token → `{id}`, row
  `pending`; agent poller turns it `done` with a real reply; `GET /api/chat/:id`
  returns it; BMO renders the exchange.
- A web message that would run Bash still raises a Telegram approval; denying it
  reflects back in the reply. Budget cap still blocks when exhausted.
- Concurrent Telegram + web messages don't corrupt the session (serialized).
- Five windows still drag/resize/focus and show live data; layout persists.
- Page is unauthenticated for reads, token-gated for sends; tailnet-only bind
  unchanged.

## Out of scope

- Cross-posting web turns into the Telegram UI (shared *context* via the session
  is enough; we don't mirror messages into Telegram).
- Streaming token-by-token replies (poll for the final reply; revisit if it
  feels slow).
- Voice, multi-user web accounts.
