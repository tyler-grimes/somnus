# User-Defined Crons (natural language) — design

> Design spec. Status: approved 2026-06-15. Next: implementation plan.

## Goal

Let the owner create recurring tasks conversationally ("add a cron to check my
inbox at 8am"). Somnus persists them and runs each on schedule as an autonomous
turn, pushing the result to Telegram. Also a one-line UX fix: tighten the
Telegram typing indicator interval so it doesn't flicker.

## Approach

Natural-language creation via **in-process Agent-SDK MCP tools** (the agent
runtime owns scheduling; this stays out of the brain's memory MCP). Crons persist
in a `user_crons` table. A one-minute pg-boss ticker fires due crons through the
existing turn machinery.

Verified: `@anthropic-ai/claude-agent-sdk@0.2.x` exports `createSdkMcpServer` +
`tool()` (in-process MCP server with zod-typed tools).

## Components

### `db/init/006_user_crons.sql` (new migration)

```sql
CREATE TABLE user_crons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT UNIQUE NOT NULL,        -- human-readable handle ("morning-inbox")
  cron_expr    TEXT NOT NULL,               -- standard 5-field cron expression
  prompt       TEXT NOT NULL,               -- the task to run as a turn
  tz           TEXT NOT NULL,               -- IANA tz; defaults to config.timezone at insert
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ,                 -- last scheduled-slot we executed (dedup)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_crons_enabled_idx ON user_crons (enabled) WHERE enabled;
```

Auto-applies on deploy via `migrate.sh`.

### `agent/src/crons.ts` (new) — persistence + due-matching (unit-tested)

- `addCron({name, cronExpr, prompt, tz?}): Promise<{ok, error?}>` — validates the
  cron expression with `cron-parser`; rejects (returns `{ok:false, error}`) on a
  bad expression, a duplicate name, or when the active-cron count is at the cap
  (`MAX_CRONS = 25`). Inserts a row (`tz` defaults to `config.timezone`).
- `listCrons(): Promise<CronRow[]>` — all crons (enabled first).
- `cancelCron(name): Promise<boolean>` — deletes by name; returns whether a row matched.
- `dueCrons(now: Date): Promise<CronRow[]>` — **pure-ish, the testable core.** For
  each enabled cron, use `cron-parser` (exact call per the pinned version) to get
  the most recent scheduled time `<= now`; a cron is due when that time is
  newer than `last_run_at` (or `last_run_at IS NULL`). Returns due rows annotated
  with the slot timestamp to stamp.
- `markRan(id, slot): Promise<void>` — sets `last_run_at = slot`.

Adds dependency: `cron-parser` (the de-facto cron lib; pg-boss already depends on it).

### `agent/src/scheduler-tools.ts` (new) — the in-process SDK MCP server

`createSdkMcpServer({ name: "scheduler", version: "1.0.0", tools: [...] })` with
three `tool()`s (zod input schemas), each calling `crons.ts` and returning a
short text result:

- `schedule_cron` — inputs `{ name, schedule, prompt }` where `schedule` is a
  standard 5-field cron expression (the model emits it from "every morning at 8" →
  `0 8 * * *"`; the tool description states this and gives examples). Calls
  `addCron`; returns success/validation error verbatim so the model can correct.
- `list_crons` — returns the active crons (name, expr, next-run).
- `cancel_cron` — input `{ name }`; calls `cancelCron`.

Exports the server config object for `agent.ts` to register.

### `agent/src/agent.ts` (modify)

- Register the scheduler server: `mcpServers: { brain: {...}, scheduler: schedulerServer }`.
- `allowedTools`: add `"mcp__scheduler__*"` alongside `"mcp__brain__*"`.
- `decidePermission`: always-allow `mcp__scheduler__*` (same trust class as brain —
  internal, typed, owner-only via the Telegram allowlist):
  `if (toolName.startsWith("mcp__scheduler__")) return allow;` next to the brain line.
- System prompt: one line telling Somnus it can schedule recurring tasks for the
  owner with `schedule_cron` (5-field cron expr) and manage them with
  `list_crons` / `cancel_cron`.

### `agent/src/scheduler.ts` (modify) — the ticker

- New queue `USER_CRON_TICK = "user-cron-tick"`, scheduled `* * * * *` (every minute).
- Handler `runDueCrons()`: `const now = new Date(); for (const c of await dueCrons(now))`
  → `const reply = await runTurnExclusive(c.prompt, "cron")` → `await notifyTelegram(\`⏰ ${c.name}\n${reply}\`)` → `await markRan(c.id, c.slot)`. Wrap each cron in try/catch so one failure doesn't block the rest; log failures.
- `runTurnExclusive` imported from `./agent.js` (no import cycle — agent.ts does not import scheduler.ts).

### `agent/src/telegram.ts` (modify) — typing tweak

Change the typing `setInterval(..., 5000)` to `4000` so the indicator never lapses
(Telegram's typing state expires at ~5s).

## Data flow

```
owner (Telegram): "remind me to review PRs every weekday at 9am"
  → agent turn → model calls mcp__scheduler__schedule_cron({name, schedule:"0 9 * * 1-5", prompt})
  → addCron() validates + inserts row → tool returns "scheduled ✓"

every minute:  pg-boss USER_CRON_TICK → runDueCrons(now)
  → dueCrons(now) [cron-parser match vs last_run_at]
  → runTurnExclusive(prompt, "cron")  [same mutex + permission + spend gates]
  → notifyTelegram(reply)  → markRan(id, slot)
```

## Error handling

- Bad cron expr / dup name / over cap → `addCron` returns `{ok:false,error}`; the
  tool surfaces it to the model, which tells the owner (no throw).
- A cron whose turn throws: caught per-cron in `runDueCrons`, logged, `last_run_at`
  still stamped so it doesn't hot-loop the same failing slot every minute; other
  crons in the same tick still run.
- Missed ticks (daemon down): on next tick, `dueCrons` runs each overdue cron once
  (most-recent slot only — no backlog storm).
- A cron turn is bounded by the existing $10/day spend cap and the permission gates
  (network/host tools still tap the owner), so a runaway prompt can't run wild.

## Testing

- `agent/src/crons.test.ts` (node:test): unit-test the due-matching logic with a
  fixed `now` and fixtures — due when slot > last_run_at; not due when already ran
  this slot; disabled crons skipped; an overdue cron after downtime fires once.
  (Factor the matching into a pure helper `isDue(cronExpr, tz, lastRunAt, now)` so
  it tests without a DB.)
- Build clean across packages; existing 41 tests stay green.
- Post-deploy manual: via Telegram, "add a cron to send me a ping every minute",
  confirm it fires + pushes, then `cancel_cron`; confirm the row is gone and it stops.

## Files touched

- Create: `db/init/006_user_crons.sql`, `agent/src/crons.ts`,
  `agent/src/scheduler-tools.ts`, `agent/src/crons.test.ts`.
- Modify: `agent/src/agent.ts` (register tools + permission + prompt),
  `agent/src/scheduler.ts` (ticker), `agent/src/telegram.ts` (4s typing),
  `agent/package.json` (`cron-parser` dep).

No change to the brain MCP. No Docker change (shared package untouched).

## Excluded (YAGNI)

One-off "run once at 3pm" reminders (recurring only for v1); `/cron` text commands
(NL only, per decision); per-cron model override; in-place editing (cancel +
recreate); dashboard display of user crons (easy follow-up — the BMO scheduler
window can read `user_crons` later).
