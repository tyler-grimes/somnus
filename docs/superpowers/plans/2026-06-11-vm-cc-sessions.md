# VM-Local Claude Code Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Somnus can run headless Claude Code sessions inside its container — clone Tyler's repos, code, push feature branches — billed to Tyler's Claude subscription, with every cc.sh call human-gated.

**Architecture:** A container-side `agent/tools/cc.sh` wrapper (name already matches `HOST_TOOL_RE` in agent.ts, so the per-invocation Telegram gate applies unchanged) drives the `claude` CLI baked into the image. Git credentials (`GITHUB_TOKEN`) are visible only to the wrapper's `clone`/`push` subcommands via `GIT_ASKPASS`; headless sessions run with `env -u ANTHROPIC_API_KEY -u GITHUB_TOKEN` so they bill the subscription (`CLAUDE_CODE_OAUTH_TOKEN`) and never see the PAT. Session costs spool to a workspace JSONL (the wrapper has no DB access by design) and a pg-boss job sweeps them into `spend_log` every 10 minutes. The agent's `<coding>` system-prompt section becomes environment-conditional, fixing the stale Mac-tool advertising on the VM.

**Tech Stack:** bash, `@anthropic-ai/claude-code` CLI, pg-boss, node:test, Docker multi-stage.

**Design spec:** `docs/superpowers/specs/2026-06-11-vm-cc-sessions-design.md`

**Grounding facts (verified):**
- `HOST_TOOL_RE = /(^|[\s/;&|])(term\.sh|cc\.sh|tmux)(\s|$)/` (agent.ts:50) — any `cc.sh` invocation routes to `requestApproval`, no standing rules (agent.ts:133-141), runs unsandboxed with subprocess env (agent.ts:105-115).
- `scrubbedSubprocessEnv()` (sandbox.ts:35) removes TELEGRAM_*/DATABASE_URL/DB_PASSWORD/OPENAI_API_KEY/APPROVAL_SIGNING_SECRET but keeps ANTHROPIC_API_KEY — and will keep GITHUB_TOKEN/CLAUDE_CODE_OAUTH_TOKEN since we deliberately do NOT add them to `SECRET_ENV_VARS`.
- `spend_log` columns: `model TEXT NOT NULL, purpose TEXT, input_tokens, output_tokens, cost_usd NUMERIC, job_id, episode_id, created_at` (db/init/001_schema.sql:194-208).
- pg-boss pattern: `createQueue` then `schedule` then `work` (scheduler.ts:31-48); pg-boss v12 named export, handler receives a jobs array (HANDOFF gotchas).
- agent package.json has NO test script yet; brain-mcp's pattern is `node --env-file-if-exists=../.env --import tsx --test src/*.test.ts`.
- The current `<coding>` prompt section (agent.ts:288-307) hardcodes Mac paths and claims all Bash needs approval — both wrong in the container.

---

### Task 1: `agent/tools/git-askpass.sh` + `agent/tools/cc.sh`

**Files:**
- Create: `agent/tools/git-askpass.sh`
- Create: `agent/tools/cc.sh`

- [ ] **Step 1: Write `agent/tools/git-askpass.sh`**

```bash
#!/usr/bin/env bash
# git credential prompt helper for cc.sh: the clone URL carries the username
# (x-access-token), so every prompt git makes gets answered with the PAT.
# Keeps the token out of argv, .git/config, and stored remotes.
echo "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
```

- [ ] **Step 2: Write `agent/tools/cc.sh`**

```bash
#!/usr/bin/env bash
# Somnus → Claude Code session driver (container variant; Mac original lives
# in tools/cc.sh and is NOT shipped in the image).
#   cc.sh clone <owner/repo>
#   cc.sh run <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh resume <session-id> <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh list
#   cc.sh push <project-dir> <branch>
#
# run/resume execute headless (claude -p, JSON out) billed to Tyler's
# subscription: ANTHROPIC_API_KEY is explicitly dropped so the CLI cannot
# fall back to API billing, leaving CLAUDE_CODE_OAUTH_TOKEN as the only auth.
# GITHUB_TOKEN is visible only to clone/push (pure git, no model involved);
# headless sessions never see it. Sessions run with acceptEdits; their own
# Bash stays disabled unless extra flags grant it.
set -euo pipefail

REPOS_DIR="${REPOS_DIR:-/app/workspace/repos}"
SPOOL="${CC_SPEND_SPOOL:-/app/workspace/.cc-spend.jsonl}"
ASKPASS="$(cd "$(dirname "$0")" && pwd)/git-askpass.sh"
DEFAULT_MODEL="claude-sonnet-4-6"

run_claude() { # <dir> <prompt> [extra flags...]
  local dir=$1 prompt=$2
  shift 2
  local model_args=()
  case " $* " in
    *" --model "*) ;;
    *) model_args=(--model "$DEFAULT_MODEL") ;;
  esac
  cd "$dir"
  local out
  out=$(env -u ANTHROPIC_API_KEY -u GITHUB_TOKEN \
    claude -p "$prompt" --output-format json --permission-mode acceptEdits \
    "${model_args[@]}" "$@")
  printf '%s\n' "$out"
  # Spend spool — cc.sh has no DB access (DATABASE_URL is scrubbed from this
  # env on purpose); the scheduler sweeps this file into spend_log.
  node -e '
    let parsed = {};
    try { parsed = JSON.parse(process.argv[1]); } catch {}
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
      session_id: parsed.session_id ?? null,
      dir: process.argv[2],
    });
    require("node:fs").appendFileSync(process.argv[3], line + "\n");
  ' "$out" "$dir" "$SPOOL" || true
}

cmd=${1:?usage: cc.sh clone|run|resume|list|push}
case "$cmd" in
  clone)
    spec=${2:?owner/repo}
    name=${spec##*/}
    mkdir -p "$REPOS_DIR"
    GIT_ASKPASS="$ASKPASS" git clone "https://x-access-token@github.com/$spec.git" "$REPOS_DIR/$name"
    echo "cloned to $REPOS_DIR/$name"
    ;;
  run)
    dir=${2:?project dir}
    prompt=${3:?prompt}
    shift 3
    run_claude "$dir" "$prompt" "$@"
    ;;
  resume)
    sid=${2:?session id}
    dir=${3:?project dir}
    prompt=${4:?prompt}
    shift 4
    run_claude "$dir" "$prompt" --resume "$sid" "$@"
    ;;
  list)
    for d in $(ls -t "$HOME/.claude/projects" 2>/dev/null | head -10); do
      latest=$(ls -t "$HOME/.claude/projects/$d" 2>/dev/null | head -1)
      echo "$d  latest: ${latest%.jsonl}"
    done
    ;;
  push)
    dir=${2:?project dir}
    branch=${3:?branch}
    case "$branch" in
      main|master)
        echo "refusing to push to $branch — use a feature branch" >&2
        exit 1
        ;;
    esac
    cd "$dir"
    GIT_ASKPASS="$ASKPASS" git push origin "HEAD:$branch"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 3: Syntax-check and set exec bits**

Run: `bash -n agent/tools/cc.sh && bash -n agent/tools/git-askpass.sh && chmod +x agent/tools/cc.sh agent/tools/git-askpass.sh && echo OK`
Expected output: `OK`

- [ ] **Step 4: Unit-test the push guard locally (no claude/git needed)**

Run: `agent/tools/cc.sh push /tmp main; echo "exit=$?"`
Expected: `refusing to push to main — use a feature branch` and `exit=1`

Run: `agent/tools/cc.sh badcmd; echo "exit=$?"`
Expected: `unknown command: badcmd` and `exit=1`

- [ ] **Step 5: Commit**

```bash
git add agent/tools/
git commit -m "feat: container cc.sh — gated headless Claude Code sessions

Subscription-billed (drops ANTHROPIC_API_KEY so the CLI can't fall back
to API billing); GitHub PAT visible only to clone/push via GIT_ASKPASS,
never to sessions; costs spool to the workspace for the scheduler sweep."
```

---

### Task 2: `agent/src/ccspend.ts` (spool sweep) — TDD

**Files:**
- Create: `agent/src/ccspend.ts`
- Create: `agent/src/ccspend.test.ts`
- Modify: `agent/package.json` (add test script)

- [ ] **Step 1: Add test script to `agent/package.json`**

In the `scripts` block, after `"cli"`, add (mirrors brain-mcp's pattern):

```json
    "test": "node --env-file-if-exists=../.env --import tsx --test src/*.test.ts"
```

- [ ] **Step 2: Write the failing test `agent/src/ccspend.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpoolLines } from "./ccspend.js";

test("parses valid JSONL lines", () => {
  const raw =
    `{"ts":"2026-06-11T20:00:00Z","usd":0.42,"session_id":"abc","dir":"/app/workspace/repos/x"}\n` +
    `{"ts":"2026-06-11T21:00:00Z","usd":0,"session_id":null,"dir":"/app/workspace/repos/y"}\n`;
  const entries = parseSpoolLines(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].usd, 0.42);
  assert.equal(entries[0].session_id, "abc");
  assert.equal(entries[1].usd, 0);
  assert.equal(entries[1].session_id, null);
});

test("drops malformed lines, keeps good ones", () => {
  const raw =
    `not json at all\n` +
    `{"ts":"2026-06-11T20:00:00Z"}\n` + // missing usd → bad shape
    `{"ts":"2026-06-11T20:00:00Z","usd":1.5,"session_id":"s","dir":"/d"}\n` +
    `\n`; // blank line ignored
  const entries = parseSpoolLines(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].usd, 1.5);
});

test("empty input yields empty array", () => {
  assert.deepEqual(parseSpoolLines(""), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent && npm test`
Expected: FAIL — `Cannot find module './ccspend.js'`

- [ ] **Step 4: Write `agent/src/ccspend.ts`**

```typescript
/**
 * cc.sh spend spool → spend_log. The cc.sh wrapper runs without DATABASE_URL
 * (deliberately scrubbed from its env), so it appends JSONL lines to the
 * workspace; this sweep ingests them every 10 minutes (scheduler.ts).
 * Subscription-billed sessions report ~$0 — these rows are observability
 * (sessions/day, repos touched) more than budget.
 */
import fs from "node:fs";
import path from "node:path";
import { pool } from "./db.js";
import { config } from "./config.js";

export interface SpoolEntry {
  ts: string;
  usd: number;
  session_id: string | null;
  dir: string;
}

const SPOOL_PATH = path.join(
  config.workspaceDir || path.resolve(import.meta.dirname, "../../workspace"),
  ".cc-spend.jsonl",
);

export function parseSpoolLines(raw: string): SpoolEntry[] {
  const entries: SpoolEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.ts !== "string" || typeof o.usd !== "number") throw new Error("bad shape");
      entries.push({
        ts: o.ts,
        usd: o.usd,
        session_id: o.session_id ?? null,
        dir: String(o.dir ?? ""),
      });
    } catch {
      console.error("[cc-spend] dropping malformed line:", line.slice(0, 200));
    }
  }
  return entries;
}

/** Returns the number of entries ingested. Rename-then-read keeps concurrent
 *  cc.sh appends safe: they just start a fresh spool file. */
export async function sweepCcSpend(spoolPath: string = SPOOL_PATH): Promise<number> {
  if (!fs.existsSync(spoolPath)) return 0;
  const ingestPath = spoolPath + ".ingest";
  fs.renameSync(spoolPath, ingestPath);
  const entries = parseSpoolLines(fs.readFileSync(ingestPath, "utf8"));
  for (const e of entries) {
    await pool.query(
      `INSERT INTO spend_log (model, purpose, cost_usd, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        "claude-code-session",
        `cc:${e.dir}${e.session_id ? ` ${e.session_id}` : ""}`,
        e.usd,
        e.ts,
      ],
    );
  }
  fs.unlinkSync(ingestPath);
  return entries.length;
}
```

(If `agent/src/db.ts` exports the pool under a different name, match it — check with `grep -n "export" agent/src/db.ts` before writing.)

- [ ] **Step 5: Run tests to verify they pass; build**

Run: `cd agent && npm test && npm run build`
Expected: 3 tests pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add agent/src/ccspend.ts agent/src/ccspend.test.ts agent/package.json
git commit -m "feat: cc.sh spend spool sweep — parse, ingest to spend_log"
```

---

### Task 3: Wire the sweep into `agent/src/scheduler.ts`

**Files:**
- Modify: `agent/src/scheduler.ts`

- [ ] **Step 1: Add the queue**

Add the import at the top (after the `briefing.js` import):

```typescript
import { sweepCcSpend } from "./ccspend.js";
```

Add the queue name constant (after `BRIEFING_QUEUE`):

```typescript
const CC_SPEND_QUEUE = "cc-spend-sweep";
```

Inside `startScheduler()`, after the briefing `boss.work(...)` block and before the final `console.log`, add:

```typescript
  await boss.createQueue(CC_SPEND_QUEUE);
  // Every 10 minutes: ingest cc.sh session costs spooled to the workspace
  await boss.schedule(CC_SPEND_QUEUE, "*/10 * * * *", {}, { tz: config.timezone });
  await boss.work(CC_SPEND_QUEUE, async () => {
    const n = await sweepCcSpend();
    if (n > 0) console.log(`[cc-spend] ingested ${n} session record(s)`);
  });
```

- [ ] **Step 2: Build**

Run: `cd agent && npm run build`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add agent/src/scheduler.ts
git commit -m "feat: schedule cc-spend sweep every 10 minutes via pg-boss"
```

---

### Task 4: Environment-conditional `<coding>` prompt section in `agent/src/agent.ts`

**Files:**
- Modify: `agent/src/agent.ts` (the `<coding>` block, currently lines 288-307)

- [ ] **Step 1: Replace the `<coding>` section**

The current template contains this block (inside the system-prompt template literal, between `${skillsPromptSection()}` and `<style>`):

```
<coding>
You can read any file (except sensitive paths: .env, keys, credentials, .ssh, .aws). You can write and edit files inside the workspace at ${WORKSPACE_DIR}. You cannot modify your own harness code or the brain schema.

Bash commands require Tyler's explicit approval via Telegram. ...
[two paragraphs about sandbox + Mac cc.sh]
[one paragraph + bullets about term.sh/tmux]
</coding>
```

Define a helper ABOVE the function that builds the system prompt (module scope, near the other prompt helpers). It selects the environment-appropriate text — `config.bashAutoApprove` is true only in the container deployment:

```typescript
/** The <coding> prompt section differs by deployment: the container has no
 *  term.sh/tmux and Bash auto-approves (container = sandbox boundary), while
 *  cc.sh delegation exists in both but with different paths and billing. */
function codingPromptSection(): string {
  if (config.bashAutoApprove) {
    return `<coding>
You can read any file (except sensitive paths: .env, keys, credentials, .ssh, .aws). You can write and edit files inside the workspace at ${WORKSPACE_DIR}. You cannot modify your own harness code or the brain schema.

Bash runs inside your locked-down container without per-command approval — the container is the sandbox. The environment is minimal (no API keys or tokens visible to commands). EXCEPTION: every cc.sh invocation requires Tyler's explicit Telegram approval, even in automode.

For real coding work in Tyler's repos (not workspace scratch), delegate to a headless Claude Code session — it runs here in the container, billed to Tyler's subscription:
- /app/agent/tools/cc.sh clone <owner/repo> — clone one of Tyler's GitHub repos into /app/workspace/repos/<repo>
- /app/agent/tools/cc.sh run <project-dir> "<task prompt>" — headless session, returns JSON with session_id and result. Write task prompts with full context: goal, constraints, how to verify.
- /app/agent/tools/cc.sh resume <session-id> <project-dir> "<follow-up>" — continue a session you started; store session_ids with remember_fact when a project thread will continue across days.
- /app/agent/tools/cc.sh list — recent sessions; you can Read their JSONL transcripts under ~/.claude/projects/
- /app/agent/tools/cc.sh push <project-dir> <branch> — push work as a feature branch (never main), then send Tyler the link https://github.com/<owner>/<repo>/compare/<branch> so he can review and merge.
Each cc.sh call is one approval — batch related work into one well-scoped session prompt rather than many small calls.

There is no term.sh or tmux on this machine: you cannot see or control Tyler's terminal sessions from here. If Tyler asks for that, tell him it requires his Mac.
</coding>`;
  }
  return `<coding>
You can read any file (except sensitive paths: .env, keys, credentials, .ssh, .aws). You can write and edit files inside the workspace at ${WORKSPACE_DIR}. You cannot modify your own harness code or the brain schema.

Bash commands require Tyler's explicit approval via Telegram. Write each command so he can approve it in ten seconds: one logical action, no chained surprises. If denied, explain what you were trying to do and propose an alternative — never re-send the same command.

Approved Bash runs inside an OS sandbox: writes only work inside the workspace, HOME points at the workspace, the environment is minimal (no API keys or tokens), and credential paths are unreadable. Commands that need the real host (term.sh, cc.sh, tmux) run outside the sandbox but always require Tyler's approval, even in automode — as do network-touching commands (curl, git push, installs).

For real coding work in Tyler's repos (not workspace scratch), delegate to a Claude Code session instead of editing files yourself:
- ${path.resolve(import.meta.dirname, "../../tools/cc.sh")} run <project-dir> "<task prompt>" — spawns a headless session, returns JSON with session_id, result, and cost. Write task prompts with full context: goal, constraints, how to verify.
- cc.sh resume <session-id> <project-dir> "<follow-up>" — continue a session you started; store session_ids with remember_fact when a project thread will continue across days.
- cc.sh list — recent Claude Code projects on this machine; you can Read their JSONL transcripts under ~/.claude/projects/ to see what past sessions did.
Each spawn is one Bash approval. For a burst of delegated work, suggest Tyler enable /auto.

You can also control Tyler's live terminal sessions when they run inside tmux, via ${path.resolve(import.meta.dirname, "../../tools/term.sh")}:
- term.sh list — every tmux pane with its running command and directory
- term.sh peek <pane> [lines] — read a pane's recent output
- term.sh send <pane> "<text>" — type into a pane (e.g. answer a Claude Code session's question, give it a new instruction)
- term.sh keys <pane> Escape — interrupt; term.sh keys <pane> C-c — kill
Etiquette: always peek before you send — confirm what's running and what state it's in. Never send destructive keys (C-c, C-d) without peeking first and telling Tyler what you saw. These are Tyler's own terminals: act like you're typing on his keyboard, because you are.
</coding>`;
}
```

Then replace the entire inline `<coding>...</coding>` block in the system-prompt template with:

```
${codingPromptSection()}
```

The Mac branch must be byte-identical to the text it replaces (it IS the current text, relocated) — diff carefully.

- [ ] **Step 2: Build + tests**

Run: `cd agent && npm run build && npm test`
Expected: clean build, tests pass.

- [ ] **Step 3: Commit**

```bash
git add agent/src/agent.ts
git commit -m "feat: environment-conditional coding prompt — container advertises VM cc.sh

The container prompt was lying since the VM migration: it claimed all
Bash needs approval and advertised Mac-only tools at Mac paths. Now the
container branch describes the real rules (Bash auto-approved, cc.sh
gated, no term.sh) and the in-container cc.sh workflow."
```

---

### Task 5: Dockerfile + compose — claude CLI, tools, claude_state volume

**Files:**
- Modify: `Dockerfile` (runtime stage)
- Modify: `docker-compose.yml` (agent service volumes + volumes section)

- [ ] **Step 1: Dockerfile runtime-stage additions**

After the existing `apt-get` RUN block in the runtime stage, add:

```dockerfile
# Claude Code CLI for cc.sh headless sessions (subscription-authed at runtime
# via CLAUDE_CODE_OAUTH_TOKEN; no API key in session env)
RUN npm install -g @anthropic-ai/claude-code
```

After the two `COPY --from=build ... dist` lines, add:

```dockerfile
COPY agent/tools/ agent/tools/
```

Change the workspace mkdir line to also pre-create `.claude` with correct ownership (the claude_state volume inherits it):

```dockerfile
RUN mkdir -p /app/workspace /home/node/.claude && chown -R node:node /app/workspace /home/node/.claude
```

- [ ] **Step 2: compose changes**

In the `agent` service `volumes:` list add the second mount, and add the named volume:

```yaml
    volumes:
      - agent_workspace:/app/workspace
      - claude_state:/home/node/.claude
```

```yaml
volumes:
  pg_data:
  agent_workspace:
  claude_state:
```

- [ ] **Step 3: Build the image locally and verify**

Run: `docker build -t somnus-agent .`
Expected: build completes.

Run: `docker run --rm somnus-agent sh -c "claude --version && ls -l /app/agent/tools/ && ls -ld /home/node/.claude"`
Expected: a claude version string; `cc.sh` and `git-askpass.sh` present with `-rwxr-xr-x`; `.claude` owned by `node`.

Run: `docker compose --profile agent config --quiet && echo OK`
Expected: `OK`

- [ ] **Step 4: Verify push-guard works inside the image (no creds needed)**

Run: `docker run --rm somnus-agent /app/agent/tools/cc.sh push /tmp main; echo "exit=$?"`
Expected: `refusing to push to main — use a feature branch`, `exit=1`

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: bake claude CLI + cc.sh into image, persist session state

claude_state volume keeps ~/.claude across restarts so cc.sh resume
works across deploys."
```

---

### Task 6: Docs — DEPLOY.md §8 + HANDOFF.md

**Files:**
- Modify: `docs/DEPLOY.md` (append new section before "## 7. Day-to-day" → renumber: insert as §7 and bump Day-to-day to §8, OR simpler: append as "## 8. Coding sessions (cc.sh)" after Day-to-day — choose append-after, no renumbering)
- Modify: `HANDOFF.md`

- [ ] **Step 1: Append to `docs/DEPLOY.md`**

````markdown

## 8. Coding sessions (cc.sh) — one-time credential setup

Somnus runs headless Claude Code sessions inside its container
(`/app/agent/tools/cc.sh`; every invocation needs a Telegram approval).
Two credentials in the VM `.env` (never on the Mac, never in git):

1. **GitHub PAT** — github.com → Settings → Developer settings →
   Fine-grained tokens → Generate: Resource owner = you; Repository access =
   the repos Somnus may touch; Permissions = Contents (Read and write) +
   Metadata (Read-only); Expiration 90 days. Then enable branch protection on
   `main` for those repos (Settings → Branches → Add rule). Add to VM `.env`:
   `GITHUB_TOKEN=github_pat_...`

2. **Claude subscription token** — on the Mac run `claude setup-token`,
   complete the browser flow, copy the token. Add to VM `.env`:
   `CLAUDE_CODE_OAUTH_TOKEN=...`  (≈1-year expiry; revoke anytime at
   claude.ai → Settings. Sessions share your plan's usage limits.)

Roll the image: `tools/deploy.sh`.

Verification:
- Ask Somnus (Telegram) to clone a small repo and make a trivial change —
  each cc.sh call should produce an approval prompt, even in automode.
- `ssh somnus-vm 'docker compose exec agent sh -c "cat /app/workspace/repos/<repo>/.git/config"'`
  — no token anywhere in it.
- Push test: have Somnus push branch `cc-test` and send the compare URL;
  verify pushing to `main` is refused by the wrapper.
- After ≤10 min: `docker compose exec -T db psql -U brain -d brain -c
  "select model, purpose, cost_usd from spend_log where model='claude-code-session' order by created_at desc limit 3;"`
- `docker compose restart agent`, then ask Somnus to `cc.sh resume` the
  earlier session — the claude_state volume should keep it. (If resume fails,
  check `docker volume ls | grep claude_state`.)
````

- [ ] **Step 2: Update `HANDOFF.md`**

In the "Repo layout" section, the `tools/cc.sh` bullet currently reads:

```
- `tools/cc.sh` — spawn/resume headless Claude Code sessions in any repo
  (`run`, `resume`, `list`). `tools/term.sh` — control live tmux panes
  (`list`/`peek`/`send`/`keys`). Both are host tools: ALWAYS human-gated,
  never covered by automode or standing rules.
```

Replace with:

```
- `tools/cc.sh` + `tools/term.sh` — Mac-only host tools (headless CC sessions /
  tmux control), NOT shipped in the image. The container variant is
  `agent/tools/cc.sh` (clone/run/resume/list/push): subscription-billed
  sessions via CLAUDE_CODE_OAUTH_TOKEN, GitHub PAT only visible to
  clone/push, costs spooled to workspace and swept to spend_log every 10
  min. ALL cc.sh/term.sh/tmux invocations are ALWAYS human-gated, never
  covered by automode or standing rules.
```

- [ ] **Step 3: Verify doc references**

Run: `grep -c "agent/tools/cc.sh" docs/DEPLOY.md HANDOFF.md`
Expected: at least 1 in each file.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY.md HANDOFF.md
git commit -m "docs: cc.sh credential setup + verification runbook; HANDOFF state"
```

---

### Task 7: Deploy + VM verification (controller/Tyler — not a subagent task)

This task is executed from the main session with Tyler in the loop; it needs
his credentials and his Telegram taps.

- [ ] **Step 1:** Tyler creates the fine-grained PAT (DEPLOY.md §8.1) and runs `claude setup-token` on the Mac (§8.2); both values appended to VM `.env` over SSH without printing them.
- [ ] **Step 2:** Push main, run `tools/deploy.sh`, watch agent boot logs.
- [ ] **Step 3:** Walk the DEPLOY.md §8 verification list end-to-end (clone, run, push-guard, spend sweep, resume-after-restart, approval prompts fire in automode).

---

## Execution notes

- Tasks 1→5 are ordered (5's image build needs 1's files; 3 imports 2's module; 4 is independent of 2-3 but builds the same package). Task 6 anytime after 1. Task 7 last, manual.
- Local docker builds in Tasks 5 require Docker Desktop running.
- Task 2 Step 4's note about `db.ts` exports: verify the pool export name before writing the import.
- Nothing here touches the running VM until Task 7.
