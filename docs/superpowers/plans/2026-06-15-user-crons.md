# User-Defined Crons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner create recurring tasks in natural language ("check my inbox at 8am"); Somnus persists them and runs each on schedule as an autonomous turn that reports to Telegram. Plus a one-line typing-indicator tweak.

**Architecture:** An in-process Agent-SDK MCP server (`scheduler`) gives the model `schedule_cron`/`list_crons`/`cancel_cron` tools backed by a `user_crons` table. A one-minute pg-boss ticker runs due crons through the existing `runTurnExclusive` turn machinery and pushes the reply via `notifyTelegram`.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), `cron-parser` v5, pg-boss, Postgres, `node --test` + `tsx`.

Spec: `docs/superpowers/specs/2026-06-15-user-crons-design.md`

---

## File Structure

- **Create** `db/init/006_user_crons.sql` — the `user_crons` table (auto-applies via migrate.sh).
- **Create** `agent/src/crons.ts` — persistence (add/list/cancel/markRan) + the pure due-matching helpers (`isValidCron`, `dueSlot`, `dueCrons`).
- **Create** `agent/src/crons.test.ts` — unit tests for the pure helpers.
- **Create** `agent/src/scheduler-tools.ts` — the in-process SDK MCP server exposing the three tools.
- **Modify** `agent/src/agent.ts` — register the server, allow its tools, add `"cron"` turn source, system-prompt line.
- **Modify** `agent/src/scheduler.ts` — the one-minute due-cron ticker.
- **Modify** `agent/src/telegram.ts` — typing interval 5000 → 4000.
- **Modify** `agent/package.json` — add `cron-parser`.

---

## Task 1: `user_crons` table + `crons.ts` persistence/matching + tests

**Files:**
- Create: `db/init/006_user_crons.sql`
- Modify: `agent/package.json`
- Create: `agent/src/crons.ts`
- Create: `agent/src/crons.test.ts`

- [ ] **Step 1: Create `db/init/006_user_crons.sql`**

```sql
-- ============================================================
-- User-defined crons: recurring tasks the owner schedules in
-- natural language. A one-minute ticker (scheduler.ts) runs each
-- due cron's prompt as a turn and reports to Telegram.
-- ============================================================
CREATE TABLE user_crons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT UNIQUE NOT NULL,        -- human handle, e.g. 'morning-inbox'
  cron_expr    TEXT NOT NULL,               -- standard 5-field cron expression
  prompt       TEXT NOT NULL,               -- task to run as a turn when it fires
  tz           TEXT NOT NULL,               -- IANA tz (defaults to config.timezone at insert)
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ,                 -- last scheduled slot we executed (dedup)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_crons_enabled_idx ON user_crons (enabled) WHERE enabled;
```

- [ ] **Step 2: Add `cron-parser` to `agent/package.json`** dependencies (keep alphabetical-ish, next to `@anthropic-ai/*`):

```json
    "cron-parser": "^5.5.0",
```

Then install:

Run: `cd agent && npm install`
Expected: `cron-parser` added, no errors.

- [ ] **Step 3: Write the failing test** — `agent/src/crons.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, isValidCron } from "./crons.js";

const tz = "America/Denver";

test("isValidCron accepts standard exprs and rejects garbage", () => {
  assert.equal(isValidCron("0 8 * * *"), true);
  assert.equal(isValidCron("0 9 * * 1-5"), true);
  assert.equal(isValidCron("not a cron"), false);
});

test("dueSlot fires when the most-recent slot is newer than last_run_at", () => {
  // 08:00 America/Denver (MDT, UTC-6 in June) = 14:00 UTC. Never run → due.
  const now = new Date("2026-06-15T14:00:30.000Z");
  const slot = dueSlot("0 8 * * *", tz, null, now);
  assert.ok(slot, "should be due");
  assert.equal(slot!.toISOString(), "2026-06-15T14:00:00.000Z");
});

test("dueSlot not due when already ran this slot", () => {
  const now = new Date("2026-06-15T14:00:30.000Z");
  const lastRun = new Date("2026-06-15T14:00:00.000Z");
  assert.equal(dueSlot("0 8 * * *", tz, lastRun, now), null);
});

test("dueSlot fires once for the most-recent slot after downtime", () => {
  // hourly; last ran 3h ago → due for 14:00 only, not 12:00/13:00.
  const now = new Date("2026-06-15T14:05:00.000Z");
  const lastRun = new Date("2026-06-15T11:00:00.000Z");
  const slot = dueSlot("0 * * * *", tz, lastRun, now);
  assert.ok(slot);
  assert.equal(slot!.toISOString(), "2026-06-15T14:00:00.000Z");
});

test("dueSlot returns null for an invalid expression (never throws)", () => {
  assert.equal(dueSlot("garbage", tz, null, new Date("2026-06-15T14:00:00.000Z")), null);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd agent && npm test`
Expected: FAIL — cannot find `./crons.js`.

- [ ] **Step 5: Implement `agent/src/crons.ts`**

```ts
/**
 * User-defined crons: persistence + due-matching. The pure helpers
 * (isValidCron, dueSlot) carry the scheduling logic and are unit-tested
 * without a DB. The ticker (scheduler.ts) and the SDK tools (scheduler-tools.ts)
 * are the only callers of the async DB functions.
 */
import { CronExpressionParser } from "cron-parser";
import { config } from "./config.js";
import { pool } from "./db.js";

export const MAX_CRONS = 25;

export interface CronRow {
  id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  tz: string;
  enabled: boolean;
  last_run_at: string | Date | null;
}

/** True if expr is a parseable 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure due-check. Returns the most-recent scheduled slot <= now if that slot is
 * newer than lastRunAt (i.e. the cron is due and hasn't run for this slot yet),
 * else null. Invalid expressions return null (never throw). Running only the
 * most-recent slot means a missed tick (daemon downtime) fires once, no backlog.
 */
export function dueSlot(cronExpr: string, tz: string, lastRunAt: Date | null, now: Date): Date | null {
  let slot: Date;
  try {
    const it = CronExpressionParser.parse(cronExpr, { currentDate: now, tz });
    slot = it.prev().toDate();
  } catch {
    return null;
  }
  if (!lastRunAt || slot.getTime() > lastRunAt.getTime()) return slot;
  return null;
}

export async function addCron(input: {
  name: string;
  cronExpr: string;
  prompt: string;
  tz?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isValidCron(input.cronExpr)) {
    return { ok: false, error: `invalid cron expression: "${input.cronExpr}"` };
  }
  const count = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_crons WHERE enabled`);
  if ((count.rows[0]?.n ?? 0) >= MAX_CRONS) {
    return { ok: false, error: `cron limit reached (${MAX_CRONS}) — cancel one first` };
  }
  try {
    await pool.query(
      `INSERT INTO user_crons (name, cron_expr, prompt, tz) VALUES ($1, $2, $3, $4)`,
      [input.name, input.cronExpr, input.prompt, input.tz ?? config.timezone],
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("user_crons_name_key") || msg.toLowerCase().includes("duplicate")) {
      return { ok: false, error: `a cron named "${input.name}" already exists` };
    }
    return { ok: false, error: msg };
  }
}

export async function listCrons(): Promise<CronRow[]> {
  const res = await pool.query<CronRow>(
    `SELECT id, name, cron_expr, prompt, tz, enabled, last_run_at
       FROM user_crons ORDER BY enabled DESC, name`,
  );
  return res.rows;
}

export async function cancelCron(name: string): Promise<boolean> {
  const res = await pool.query(`DELETE FROM user_crons WHERE name = $1`, [name]);
  return (res.rowCount ?? 0) > 0;
}

/** All enabled crons that are due at `now`, annotated with the slot to stamp. */
export async function dueCrons(now: Date): Promise<Array<{ row: CronRow; slot: Date }>> {
  const res = await pool.query<CronRow>(
    `SELECT id, name, cron_expr, prompt, tz, enabled, last_run_at FROM user_crons WHERE enabled`,
  );
  const out: Array<{ row: CronRow; slot: Date }> = [];
  for (const row of res.rows) {
    const last = row.last_run_at ? new Date(row.last_run_at) : null;
    const slot = dueSlot(row.cron_expr, row.tz, last, now);
    if (slot) out.push({ row, slot });
  }
  return out;
}

export async function markRan(id: string, slot: Date): Promise<void> {
  await pool.query(`UPDATE user_crons SET last_run_at = $2 WHERE id = $1`, [id, slot.toISOString()]);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd agent && npm test`
Expected: PASS — the 5 new `crons` tests pass alongside the existing suite.

- [ ] **Step 7: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 8: Commit**

```bash
git add db/init/006_user_crons.sql agent/src/crons.ts agent/src/crons.test.ts agent/package.json agent/package-lock.json
git commit -m "feat(crons): user_crons table + persistence/due-matching helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `scheduler-tools.ts` — in-process SDK MCP server

**Files:**
- Create: `agent/src/scheduler-tools.ts`

- [ ] **Step 1: Implement `agent/src/scheduler-tools.ts`**

```ts
/**
 * In-process Agent-SDK MCP server exposing scheduling tools. Scheduling is an
 * agent-runtime concern (the agent owns the pg-boss scheduler), so it lives
 * here rather than in the brain's memory MCP. Wired into agent.ts mcpServers.
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { addCron, listCrons, cancelCron } from "./crons.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const scheduleCron = tool(
  "schedule_cron",
  "Schedule a recurring task for the owner. `schedule` MUST be a standard 5-field " +
    "cron expression (minute hour day-of-month month day-of-week): e.g. '0 8 * * *' = " +
    "daily 8am, '0 9 * * 1-5' = weekdays 9am, '*/30 * * * *' = every 30 minutes. When the " +
    "cron fires, `prompt` runs as a turn and the result is sent to the owner on Telegram. " +
    "`name` is a short kebab-case handle. Returns an error string if the expression is " +
    "invalid or the name is taken — relay it to the owner and try again.",
  { name: z.string(), schedule: z.string(), prompt: z.string() },
  async ({ name, schedule, prompt }) => {
    const r = await addCron({ name, cronExpr: schedule, prompt });
    return text(
      r.ok
        ? `Scheduled "${name}" (${schedule}). It will run and report on Telegram.`
        : `Could not schedule: ${r.error}`,
    );
  },
);

const listCronsTool = tool(
  "list_crons",
  "List the owner's scheduled recurring tasks (crons).",
  {},
  async () => {
    const rows = await listCrons();
    if (!rows.length) return text("No crons scheduled.");
    return text(
      rows
        .map((c) => `• ${c.name} [${c.cron_expr}]${c.enabled ? "" : " (disabled)"} — ${c.prompt.slice(0, 80)}`)
        .join("\n"),
    );
  },
);

const cancelCronTool = tool(
  "cancel_cron",
  "Cancel (delete) a scheduled cron by its name.",
  { name: z.string() },
  async ({ name }) => {
    const ok = await cancelCron(name);
    return text(ok ? `Canceled "${name}".` : `No cron named "${name}".`);
  },
);

export const schedulerMcpServer = createSdkMcpServer({
  name: "scheduler",
  version: "1.0.0",
  tools: [scheduleCron, listCronsTool, cancelCronTool],
});
```

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean. (If `tool`'s empty-schema `{}` for `list_crons` errors, that's a real signal — but the SDK types `AnyZodRawShape` accept an empty object; report if not.)

- [ ] **Step 3: Commit**

```bash
git add agent/src/scheduler-tools.ts
git commit -m "feat(crons): in-process SDK scheduler MCP tools (schedule/list/cancel)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Wire the scheduler tools + `cron` turn source into `agent.ts`

**Files:**
- Modify: `agent/src/agent.ts`

- [ ] **Step 1: Add the import** — after `import { skillsPromptSection } from "./skills.js";`:

```ts
import { schedulerMcpServer } from "./scheduler-tools.js";
```

- [ ] **Step 2: Add `"cron"` to BOTH turn-source unions.** There are two identical signatures `source: "telegram" | "cli" | "web",` — one on `runAgentTurn` (~line 355) and one on `runTurnExclusive` (~line 473). Change both to:

```ts
  source: "telegram" | "cli" | "web" | "cron",
```

- [ ] **Step 3: Register the scheduler server** in the `mcpServers` block (after the `brain: {...}` entry):

```ts
        mcpServers: {
          brain: {
            command: "node",
            args: [BRAIN_MCP_PATH],
            env: {
              DATABASE_URL: config.databaseUrl,
              OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
            },
          },
          scheduler: schedulerMcpServer,
        },
```

- [ ] **Step 4: Allow the scheduler tools** — change the `allowedTools` line:

```ts
        allowedTools: ["mcp__brain__*", "mcp__scheduler__*"],
```

- [ ] **Step 5: Always-allow scheduler tools in `decidePermission`** — directly after the brain line (`if (toolName.startsWith("mcp__brain__")) return allow;`, ~line 77), add:

```ts
  if (toolName.startsWith("mcp__scheduler__")) return allow;
```

- [ ] **Step 6: Tell the model about the tools in the system prompt.** In the function that builds the system prompt string (the big template literal returning the prompt, where memory tools like `search_memory`/`log_friction` are described), add one sentence describing the scheduler capability. Insert it adjacent to the other tool descriptions:

```
You can schedule recurring tasks for ${config.ownerName}: call schedule_cron with a short name, a standard 5-field cron expression (e.g. "0 8 * * *" for daily 8am, "0 9 * * 1-5" for weekdays 9am), and the prompt to run when it fires — the result is sent to Telegram. Use list_crons to see them and cancel_cron to remove one. Translate the owner's natural request ("every weekday morning") into the cron expression yourself.
```

- [ ] **Step 7: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 8: Run tests**

Run: `cd agent && npm test`
Expected: PASS (all existing + crons tests).

- [ ] **Step 9: Commit**

```bash
git add agent/src/agent.ts
git commit -m "feat(crons): wire scheduler MCP tools + cron turn source into the agent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: One-minute due-cron ticker in `scheduler.ts`

**Files:**
- Modify: `agent/src/scheduler.ts`

- [ ] **Step 1: Add imports** — after the existing imports at the top of `scheduler.ts`:

```ts
import { runTurnExclusive } from "./agent.js";
import { dueCrons, markRan } from "./crons.js";
```

(No import cycle: `agent.ts` does not import `scheduler.ts`.)

- [ ] **Step 2: Add the queue constant** — next to the other `*_QUEUE` consts:

```ts
const USER_CRON_TICK = "user-cron-tick";
```

- [ ] **Step 3: Register the ticker** inside `startScheduler`, after the `GAP_ANALYSIS_QUEUE` worker block and before the final `console.log("[boot] scheduler up ...")`:

```ts
  await boss.createQueue(USER_CRON_TICK);
  // Every minute: run any user-defined cron whose scheduled slot just passed.
  await boss.schedule(USER_CRON_TICK, "* * * * *", {}, { tz: config.timezone });
  await boss.work(USER_CRON_TICK, async () => {
    const now = new Date();
    for (const { row, slot } of await dueCrons(now)) {
      try {
        const reply = await runTurnExclusive(row.prompt, "cron");
        await notifyTelegram(`⏰ ${row.name}\n${reply}`);
      } catch (err) {
        console.error(`[user-cron] "${row.name}" failed:`, err);
      } finally {
        // Stamp the slot even on failure so a broken cron can't hot-loop every minute.
        await markRan(row.id, slot);
      }
    }
  });
```

- [ ] **Step 4: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 5: Run tests**

Run: `cd agent && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/src/scheduler.ts
git commit -m "feat(crons): one-minute ticker runs due user crons -> turn -> Telegram

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Tighten the Telegram typing interval

**Files:**
- Modify: `agent/src/telegram.ts`

- [ ] **Step 1: Change the typing interval** in the `message:text` handler (~line 230). Find:

```ts
      const typing = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);
```

Change `5000` to `4000` (Telegram's typing state expires at ~5s; 4s keeps it from lapsing):

```ts
      const typing = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
```

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add agent/src/telegram.ts
git commit -m "fix(telegram): refresh typing indicator every 4s so it never lapses

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Build, deploy, verify

**Files:** none (integration + ops; controller runs against production).

- [ ] **Step 1: Full build + tests**

Run: `cd agent && npm run build && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 2: Merge to main + push + deploy**

```bash
git checkout main && git merge --ff-only <feature-branch> && git push origin main
bash tools/deploy.sh
```
Expected: VM rebuilds, migration `006_user_crons.sql` applies (`[migrate] applying 006_user_crons.sql`), all 3 containers up, agent boots clean (`[boot] scheduler up …`).

- [ ] **Step 3: Verify migration + table**

Run: `ssh somnus-vm "cd ~/somnus && docker compose --profile agent exec -T db psql -U brain -d brain -tA -c 'SELECT count(*) FROM user_crons;'"`
Expected: `0` (table exists, empty).

- [ ] **Step 4: Manual end-to-end via Telegram**

Send: "add a cron that sends me a one-line ping every minute named test-ping". Confirm Somnus reports it scheduled, then confirm a `⏰ test-ping` message arrives within ~1 minute. Then send "cancel the test-ping cron" and confirm it stops + `list_crons` shows it gone.

- [ ] **Step 5: Done** — report status.

---

## Self-Review

- **Spec coverage:** in-process SDK scheduler tools (Task 2 + Task 3 wiring); `user_crons` table (Task 1); NL creation via `schedule_cron` + system-prompt line (Tasks 2/3); one-minute ticker → `runTurnExclusive(prompt,"cron")` → `notifyTelegram` → `markRan` (Task 4); MAX_CRONS cap + cron validation + dup-name handling (Task 1 `addCron`); missed-tick-fires-once + per-cron error isolation (Task 1 `dueSlot` + Task 4 try/catch/finally); typing tweak (Task 5); deploy + migration + manual verify (Task 6). All spec sections mapped.
- **Type consistency:** `CronRow` shape and `dueSlot(cronExpr, tz, lastRunAt, now)` / `dueCrons(now) → {row, slot}[]` / `addCron({name,cronExpr,prompt,tz?})` / `cancelCron(name)` / `markRan(id, slot)` defined in Task 1 and consumed unchanged in Tasks 2 (tools call `addCron`/`listCrons`/`cancelCron`) and 4 (`dueCrons`/`markRan`). `schedulerMcpServer` exported in Task 2, imported in Task 3. `"cron"` added to BOTH source unions in Task 3 so `runTurnExclusive(prompt,"cron")` in Task 4 type-checks. Tool result shape `{content:[{type:"text" as const,text}]}` matches the SDK `CallToolResult`.
- **Placeholder scan:** none; every code step is complete. The one prose insertion (Task 3 Step 6 system-prompt line) gives the exact sentence to add.
- **Decoupling note:** `crons.test.ts` imports only the pure helpers (`dueSlot`, `isValidCron`); importing `crons.ts` loads `config` + `pool` (Pool construction doesn't open a connection) — safe under the dummy local `.env`, same as existing tests.
- **Scope:** single plan.
