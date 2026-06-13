# BMO Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web console with a gruvbox 8-bit scene — a BMO whose screen is a live chat terminal to Somnus (web→agent via a DB handoff) — surrounded by the existing five data windows, reskinned.

**Architecture:** A `web_chat` table in the shared Postgres is the seam. The dashboard `POST /api/chat` (token-gated) inserts a pending row; an agent-side poller claims it, runs the turn through a shared single-flight mutex (so web and Telegram never run concurrently against the one SDK session), and writes the reply back; the page polls for it. Tool-approval and the daily budget gate already wrap every turn, so they carry over to web turns for free.

**Tech Stack:** Postgres, Express, pg, Claude Agent SDK, vanilla JS/CSS (no build for the page).

**Spec:** `docs/superpowers/specs/2026-06-12-bmo-console-design.md`

**Grounding facts (verified):**
- `runAgentTurn(userText, source: "telegram"|"cli"): Promise<string>` (agent.ts:365) returns the reply text and uses a module-level `lastSessionId` (agent.ts:345) — so all callers share one SDK session.
- Telegram already serializes its own turns via an `inflight` promise chain (telegram.ts:223) and must never block the grammY update loop (HANDOFF gotcha). We add a *shared* mutex so the web poller and Telegram interleave safely.
- migrate service auto-applies `db/init/*.sql` on deploy (tracked in `schema_migrations`); new files apply once.
- dashboard `server.ts` is Express, binds `0.0.0.0:3001` (port mapping restricts to the tailnet IP via `DASHBOARD_BIND`), shares Postgres via `DATABASE_URL`. Read APIs return JSON; no body parser yet.
- The current `dashboard/public/index.html` holds working drag/resize/focus/localStorage window machinery + the five render functions and pollers — reuse that logic, reskinned (don't reinvent it).

**Testing note:** agent has `node --test` (10 tests pass today). Backend logic gets unit tests where pure (the mutex); DB/HTTP/UI paths are verified with commands + the manual end-to-end in Task 9.

---

### Task 1: `web_chat` migration

**Files:**
- Create: `db/init/004_web_chat.sql`

- [ ] **Step 1: Write `db/init/004_web_chat.sql`**

```sql
-- Web console ↔ Somnus chat handoff. The dashboard inserts a pending row;
-- the agent poller (webchat.ts) claims it, runs a turn, writes the reply.
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

- [ ] **Step 2: Validate SQL parses (idempotent re-run safe)**

Run: `grep -c "IF NOT EXISTS" db/init/004_web_chat.sql`
Expected: `2` (both the table and the index are idempotent — the migrate runner can re-apply safely).

- [ ] **Step 3: Commit**

```bash
git add db/init/004_web_chat.sql
git commit -m "feat: web_chat table — web console ↔ Somnus chat handoff"
```

---

### Task 2: Shared single-flight turn mutex (agent.ts) — TDD

**Files:**
- Modify: `agent/src/agent.ts`
- Create: `agent/src/turnlock.test.ts`

- [ ] **Step 1: Add `"web"` to the source union**

In `agent.ts`, change `runAgentTurn`'s signature:
```typescript
export async function runAgentTurn(
  userText: string,
  source: "telegram" | "cli" | "web",
): Promise<string> {
```
And `logEpisode({ source, role: "user", content: userText })` already passes `source` through — no other change needed there.

- [ ] **Step 2: Add the exclusive runner at the end of agent.ts (module scope)**

```typescript
/**
 * Serialize every agent turn (Telegram + web) through one chain. runAgentTurn
 * shares a single SDK session (lastSessionId); two concurrent turns would
 * corrupt it. The chain never breaks on a failed turn (we swallow the error
 * for the *chain*, while the caller still gets the original promise's result).
 */
let turnChain: Promise<unknown> = Promise.resolve();
export function runTurnExclusive(
  userText: string,
  source: "telegram" | "cli" | "web",
): Promise<string> {
  const result = turnChain.then(() => runAgentTurn(userText, source));
  turnChain = result.catch(() => {});
  return result;
}
```

- [ ] **Step 3: Write the failing test `agent/src/turnlock.test.ts`**

This tests the serialization primitive in isolation (no SDK/DB) by replicating the chain logic against a tracked async fn — verifying non-overlap and that a rejection doesn't wedge the chain.

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of runTurnExclusive's chaining, parameterized over the work fn,
// so we can verify the concurrency contract without the SDK.
function makeRunner(work: (s: string) => Promise<string>) {
  let chain: Promise<unknown> = Promise.resolve();
  return (s: string) => {
    const r = chain.then(() => work(s));
    chain = r.catch(() => {});
    return r;
  };
}

test("runs are serialized (never overlap)", async () => {
  let active = 0, maxActive = 0;
  const work = async (s: string) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--; return s;
  };
  const run = makeRunner(work);
  await Promise.all(["a","b","c","d"].map(run));
  assert.equal(maxActive, 1);
});

test("a rejected turn does not wedge the chain", async () => {
  const run = makeRunner(async (s) => { if (s === "boom") throw new Error("x"); return s; });
  await assert.rejects(run("boom"));
  assert.equal(await run("ok"), "ok");   // chain still flows
});
```

- [ ] **Step 4: Run tests**

Run: `cd agent && npm test 2>&1 | grep -E "pass|fail"`
Expected: all pass (12 total now).

- [ ] **Step 5: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 6: Commit**

```bash
git add agent/src/agent.ts agent/src/turnlock.test.ts
git commit -m "feat: runTurnExclusive — shared single-flight mutex for all agent turns"
```

---

### Task 3: Telegram uses the exclusive runner

**Files:**
- Modify: `agent/src/telegram.ts`

- [ ] **Step 1: Import and switch the call**

In `telegram.ts`, change the import from agent.js to include `runTurnExclusive`, and in the text handler replace `runAgentTurn(text, "telegram")` with `runTurnExclusive(text, "telegram")`. The surrounding `inflight` chain and typing indicator stay as-is (it serializes Telegram-with-Telegram for the typing UX; the new mutex serializes across channels). Current line (telegram.ts:229):
```typescript
        const reply = await runAgentTurn(text, "telegram");
```
becomes:
```typescript
        const reply = await runTurnExclusive(text, "telegram");
```
Update the import line to pull `runTurnExclusive` (keep `runAgentTurn` only if still referenced elsewhere in the file; if not, replace it).

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean (no unused-import error).

- [ ] **Step 3: Commit**

```bash
git add agent/src/telegram.ts
git commit -m "feat: Telegram turns go through the shared mutex (no overlap with web)"
```

---

### Task 4: Web chat poller (agent)

**Files:**
- Create: `agent/src/webchat.ts`

- [ ] **Step 1: Write `agent/src/webchat.ts`**

```typescript
/**
 * Drains web_chat: claims one pending row at a time (FOR UPDATE SKIP LOCKED),
 * runs it through the shared turn mutex, writes the reply back. Self-paced —
 * processes immediately while work exists, idles 2s when the queue is empty.
 * A failed turn is recorded as status='error' with the error text; a DB error
 * leaves the row for the next pass (never lost).
 */
import { pool } from "./db.js";
import { runTurnExclusive } from "./agent.js";

const IDLE_MS = 2000;
let running = false;

async function claimOne(): Promise<{ id: string; prompt: string } | null> {
  const { rows } = await pool.query(
    `UPDATE web_chat SET status='running'
       WHERE id = (
         SELECT id FROM web_chat WHERE status='pending'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, prompt`,
  );
  return rows[0] ?? null;
}

export function startWebChatPoller(): void {
  if (running) return;
  running = true;
  const tick = async () => {
    let claimed: { id: string; prompt: string } | null = null;
    try {
      claimed = await claimOne();
      if (claimed) {
        try {
          const reply = await runTurnExclusive(claimed.prompt, "web");
          await pool.query(
            `UPDATE web_chat SET reply=$2, status='done', answered_at=now() WHERE id=$1`,
            [claimed.id, reply],
          );
        } catch (err) {
          await pool.query(
            `UPDATE web_chat SET reply=$2, status='error', answered_at=now() WHERE id=$1`,
            [claimed.id, err instanceof Error ? err.message : String(err)],
          );
        }
      }
    } catch (err) {
      console.error("[webchat] poll failed:", err);   // DB hiccup — try again next pass
    }
    setTimeout(tick, claimed ? 0 : IDLE_MS);
  };
  console.log("[boot] web chat poller up");
  void tick();
}
```

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add agent/src/webchat.ts
git commit -m "feat: web chat poller — claim pending web_chat rows, run turn, write reply"
```

---

### Task 5: Start the poller at boot

**Files:**
- Modify: `agent/src/index.ts`

- [ ] **Step 1: Import and start**

In `index.ts`, add to the imports:
```typescript
import { startWebChatPoller } from "./webchat.js";
```
In `main()`, after `const boss = await startScheduler();` (and after the bot is created/started is fine too — it only needs the pool), add:
```typescript
  startWebChatPoller();
```

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat: start web chat poller on agent boot"
```

---

### Task 6: Dashboard chat endpoints + token

**Files:**
- Modify: `dashboard/server.ts`

- [ ] **Step 1: Add a JSON body parser and the token constant**

Near the top of `server.ts`, after `const app = express();`:
```typescript
app.use(express.json({ limit: '64kb' }));
const CHAT_TOKEN = process.env.CHAT_TOKEN ?? '';
```

- [ ] **Step 2: Add the three chat routes** (before `app.listen`)

```typescript
app.post('/api/chat', async (req, res) => {
  if (CHAT_TOKEN && req.get('x-somnus-token') !== CHAT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const text = (req.body?.text ?? '').toString().trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (text.length > 4000) return res.status(400).json({ error: 'message too long' });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO web_chat (prompt) VALUES ($1) RETURNING id`, [text]);
    res.json({ id: rows[0].id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/chat/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, reply FROM web_chat WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/chat/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT prompt, reply, status, created_at FROM web_chat
       ORDER BY created_at DESC LIMIT 20`);
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: String(err) }); }
});
```

- [ ] **Step 3: Verify it builds in the image context (tsc runs in the dashboard image)**

Run: `cd dashboard && node -e "require('fs').readFileSync('server.ts','utf8').includes('/api/chat') && console.log('routes present')"`
Expected: `routes present` (local tsc isn't installed; the dashboard image compiles it on deploy — Task 9 confirms).

- [ ] **Step 4: Commit**

```bash
git add dashboard/server.ts
git commit -m "feat(dashboard): /api/chat endpoints (token-gated POST, poll, history)"
```

---

### Task 7: Wire CHAT_TOKEN through compose + env example

**Files:**
- Modify: `docker-compose.yml`, `.env.example`

- [ ] **Step 1: Pass CHAT_TOKEN to the dashboard service**

In `docker-compose.yml`, the `dashboard` service `environment:` block (which has `DATABASE_URL` and `TZ`), add:
```yaml
      CHAT_TOKEN: ${CHAT_TOKEN:-}
```

- [ ] **Step 2: Document it in `.env.example`**

Append:
```
# CHAT_TOKEN=                # secret required to SEND messages to Somnus from the web console
#                           # (read-only windows stay open on the tailnet; sends need this)
```

- [ ] **Step 3: Validate compose**

Run: `docker compose --profile agent config --quiet && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(dashboard): plumb CHAT_TOKEN env to the dashboard service"
```

---

### Task 8: Full page rewrite — gruvbox 8-bit, BMO chat, reskinned windows

**Files:**
- Modify: `dashboard/public/index.html` (full rewrite)

This is the large creative task. Build a self-contained page (no external CDNs — tailnet-only) with three parts: gruvbox 8-bit theme, the BMO chat terminal (the new functional core, code given verbatim below), and the five data windows (reuse the current file's drag/resize/focus/localStorage + render/poll logic, reskinned).

- [ ] **Step 1: Theme tokens (CSS `:root`)** — use exactly these gruvbox values

```css
:root{
  --bg:#282828; --bg-h:#1d2021; --bg-s:#32302f; --fg:#ebdbb2; --gray:#928374;
  --red:#fb4934; --green:#b8bb26; --yellow:#fabd2f; --blue:#83a598;
  --purple:#d3869b; --aqua:#8ec07c; --orange:#fe8019;
  --mono: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
}
```
8-bit treatment: `image-rendering:pixelated` on pixel-art elements, 3px hard borders, **offset block shadows** (`box-shadow:4px 4px 0 #1d2021`, no blur), a faint scanline overlay (`repeating-linear-gradient` at low opacity), blocky monospace with letter-spacing. No blur/glassmorphism.

- [ ] **Step 2: BMO markup + face states** — CSS pixel-art BMO with a screen that hosts the chat

Structure (build the body/buttons in CSS; the screen contains the chat):
```html
<div id="bmo">
  <div class="bmo-screen">
    <div id="bmo-face" data-mood="awake"><span class="eye l"></span><span class="eye r"></span><span class="mouth"></span></div>
    <div id="chatlog" class="chatlog"></div>
    <form id="chatform"><input id="chatinput" autocomplete="off"
      placeholder="talk to somnus…" /><button>▶</button></form>
  </div>
  <div class="bmo-controls"><span class="dpad"></span>
    <span class="btn green"></span><span class="btn red"></span>
    <span class="btn blue"></span><span class="btn yellow"></span></div>
</div>
```
Face state via `#bmo-face[data-mood]`: `awake` (slow blink), `thinking` (eyes → `· ·` / animated dots while a send is in flight), `happy` (mouth curve on reply), `dreaming` / `resting` from the scheduler poll (reuse the scheduler render's `dreaming` flag + the 00:00–06:00 rule). Set `data-mood` from JS.

- [ ] **Step 3: Chat client JS** — use this verbatim (the functional contract)

```javascript
const TOKEN_KEY = 'somnus.chatToken';
const log = document.getElementById('chatlog');
const form = document.getElementById('chatform');
const input = document.getElementById('chatinput');
const face = document.getElementById('bmo-face');

function addMsg(who, text){
  const d = document.createElement('div');
  d.className = 'msg ' + who;            // who: 'you' | 'somnus' | 'sys'
  d.textContent = text;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
  return d;
}
function setMood(m){ face.dataset.mood = m; }

async function loadHistory(){
  try {
    const r = await fetch('/api/chat/history', {cache:'no-store'});
    const rows = await r.json();
    for (const row of rows){
      addMsg('you', row.prompt);
      if (row.reply) addMsg(row.status === 'error' ? 'sys' : 'somnus', row.reply);
    }
  } catch {}
}

async function send(text){
  addMsg('you', text); setMood('thinking');
  const headers = {'content-type':'application/json'};
  const tok = localStorage.getItem(TOKEN_KEY);
  if (tok) headers['x-somnus-token'] = tok;
  let res;
  try { res = await fetch('/api/chat', {method:'POST', headers, body:JSON.stringify({text})}); }
  catch(e){ setMood('awake'); return addMsg('sys', 'offline: '+e.message); }
  if (res.status === 401){
    setMood('awake');
    const t = prompt('Somnus chat is locked. Enter the chat token:');
    if (t){ localStorage.setItem(TOKEN_KEY, t); return send(text); }   // retry once
    return addMsg('sys', 'locked — token required to send.');
  }
  if (!res.ok){ setMood('awake'); return addMsg('sys', 'error: '+(await res.text())); }
  const { id } = await res.json();
  pollReply(id);
}

async function pollReply(id, tries=0){
  if (tries > 60){ setMood('awake'); return addMsg('sys','(timed out waiting for Somnus)'); }
  try {
    const r = await fetch('/api/chat/'+id, {cache:'no-store'});
    const d = await r.json();
    if (d.status === 'done'){ setMood('happy'); addMsg('somnus', d.reply); setTimeout(()=>setMood('awake'),3000); return; }
    if (d.status === 'error'){ setMood('awake'); addMsg('sys', d.reply || 'turn failed'); return; }
  } catch {}
  setTimeout(()=>pollReply(id, tries+1), 1500);   // pending/running
}

form.addEventListener('submit', e=>{
  e.preventDefault();
  const text = input.value.trim(); if(!text) return;
  input.value=''; send(text);
});
loadHistory();
```

- [ ] **Step 4: Five data windows — reuse, reskin**

Port the window machinery from the previous `index.html` (it's in git history / the working tree before this rewrite): the `WINDOWS` defs, `makeWindow`/drag/resize/focus/`localStorage` layout, and the `renderMemory/renderEpisodes/renderSessions/renderSpend/renderScheduler` + `poll`/`pollAll` functions all stay functionally identical (same endpoints, same fields). Reskin only: gruvbox card chrome (titlebar with pixel label + colored dots in accent colors, hard borders, block shadow, scanline). Drop the orb/tendril canvas and the `gaze`/`ripple`/`drawLinks` code — BMO replaces the central orb. Keep the starfield optional/removed; a flat gruvbox bg with a subtle scanline is enough. Default layout: arrange the five windows around the centered BMO (same ring math, BMO occupies the center instead of the orb). The scheduler poll still sets the `dreaming` flag → feed it to `setMood`.

- [ ] **Step 5: Verify the page parses and self-contains**

Run: `node -e "const h=require('fs').readFileSync('dashboard/public/index.html','utf8'); const m=h.match(/<script>([\s\S]*)<\/script>/); require('vm').compileFunction(m[1]); console.log('inline JS parses'); console.log('no external http(s) refs:', !/src=\"https?:|href=\"https?:/.test(h));"`
Expected: `inline JS parses` and `no external http(s) refs: true`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/index.html
git commit -m "feat(dashboard): gruvbox 8-bit BMO console — chat terminal + reskinned windows"
```

---

### Task 9: Deploy + end-to-end verification (controller/Tyler)

- [ ] **Step 1:** Push main. Set `CHAT_TOKEN` in the VM `.env` (`openssl rand -hex 16`). Run `tools/deploy.sh` (migrate applies `004_web_chat.sql`; agent restarts with the poller; dashboard rebuilds).
- [ ] **Step 2:** Confirm `web_chat` exists and the poller logged `[boot] web chat poller up`.
- [ ] **Step 3:** `POST /api/chat` with no token → 401; with the token → `{id}`; within seconds `GET /api/chat/:id` returns `status:done` + a real reply.
- [ ] **Step 4:** Open `http://somnus-vm:3001/` — BMO renders, history loads, a sent message gets a reply, face animates (thinking→happy); the five windows drag/resize/focus and show live data.
- [ ] **Step 5:** Send a message that asks Somnus to run a Bash command → confirm a Telegram approval still fires (tool-gate carries over). Confirm budget-exhausted path returns the budget message.

---

## Execution notes

- Backend order matters: Task 2 (mutex) before 3 (telegram uses it) and 4 (poller uses it); 5 starts the poller; 1 (table) before 4/6 run live but can be committed anytime. Task 8 depends on 6's endpoints existing. Task 9 last, with Tyler.
- Tasks 1–8 are codeable/committable locally (dashboard tsc runs in its image on deploy; the page checks are node syntax checks). Don't deploy before `CHAT_TOKEN` is set if you want sends locked (unset = sends open on the tailnet).
- No change to `decidePermission` — the tool-approval + budget gates already wrap `runAgentTurn`, so they cover web turns unchanged.
