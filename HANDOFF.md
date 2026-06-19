# HANDOFF — Somnus (adhd_squared)

> Context document for a fresh Claude Code session. Read this, then `README.md`,
> then skim `research/README.md`. Everything here was true as of 2026-06-19.

## What this is

**Somnus** — an always-on, single-user second-brain agent (named for the Roman
god of sleep: its deepest work happens in the nightly "dream cycle"). Goal:
organize what its owner works on and know them better than they know themselves.
**Live 24/7 on a VM**, in daily use via Telegram + a web console.
GitHub: `tyler-grimes/somnus` (private).

The codebase is now **generic/shareable** — the owner's name comes from
`OWNER_NAME` (default `"your owner"`); prompts/tools no longer hardcode "Tyler"
or assume macOS. This deployment sets `OWNER_NAME=Tyler`. (This HANDOFF still
says "Tyler" — it's his own context doc.)

## Architecture in one paragraph

The load-bearing decision is the **brain/agent seam**: a self-owned memory
engine (single Postgres + pgvector — vectors, full-text, typed-edge graph,
bitemporal facts, job queue, all in one DB) exposed as an MCP server
(`brain-mcp/`), with a **replaceable** agent runtime on top (`agent/`, Claude
Agent SDK). The brain is the durable asset; the agent is a client. A read/chat
**web console** (`dashboard/`) is a third container over the same DB. Every
architecture choice traces to adversarially-verified research in `research/`.

## Repo layout

- `db/init/*.sql` — schema, applied in order:
  - `001_schema.sql`: `pages`, `content_chunks` (HALFVEC(1536)+HNSW), bitemporal
    `facts`, typed `edges`, append-only `episodes`, `friction_events`,
    `command_rules`, `settings`, `spend_log`.
  - `002_visibility.sql` (facts_world/facts_shared views — `CREATE OR REPLACE`),
    `003_cc_sessions.sql`, `004_web_chat.sql`, `005_trgm_indexes.sql` (GIN trgm on
    facts.claim + friction.description), `006_user_crons.sql`, `007_scratch_memory.sql`,
    `008_relationship_kind.sql` (widens `facts_kind_check` to add `relationship`+`scratch`),
    `009_project_contexts.sql`.
  - `db/migrate.sh` — one-shot `migrate` compose service applies any unapplied
    `*.sql` once each on deploy (tracked in `schema_migrations`); baseline-adopts
    pre-existing schema since 001/002 aren't idempotent. **New migrations now
    auto-apply on deploy** — no more manual psql. NOTE: migrations live in
    `db/init/` (mounted to `/migrations`), NOT `db/migrations/`; number them
    sequentially (next free = 010).
  - Postgres via `docker-compose.yml` (pgvector/pg17; **local dev port 5433**).
- `brain-mcp/` — stdio MCP server, **17 tools**. Memory core: `search_memory`
  (hybrid RRF), `remember_fact`, `supersede_fact`, `core_blocks`,
  `recent_episodes`, `log_friction`, `search_cc_sessions`. Added: `update_fact`
  (one-call supersede-or-create), scratchpad `set_scratch`/`get_scratch`/
  `clear_scratch`, people `remember_person`/`get_people`, project context
  `set_project_context`/`get_project_context`/`list_projects`/`set_current_project`.
  Shared `supersedeFactInTx()` helper backs all supersede paths. Write-time
  embeddings via OpenAI text-embedding-3-small (now from the `somnus-shared` pkg).
- `agent/src/` — the harness:
  - `agent.ts` — turn loop (`runAgentTurn`), **`runTurnExclusive` single-flight
    mutex** (all turns — telegram/cli/web — serialize through one SDK session),
    researched system prompt, Letta-style core blocks, layered
    `decidePermission`, live-switchable chat model, session resume.
  - `dream.ts` — nightly 04:00 consolidation; **chains gap analysis on
    completion** (see scheduler). extract → contradictions → reflection →
    **`linkPages` (derive page edges)** → persona evolution → friction
    clustering → skill drafting → embedding backfill → decay/purge (now also
    clears `scratch_memory`). Ingested content spotlighted untrusted.
  - `gap-analysis.ts` — reviews recent episodes → finds open questions/
    unresolved problems → researches via stored memory (Haiku classify, Sonnet
    research) → pushes high-priority findings to Telegram. Spend-capped before +
    inside the loop. Manual `/gaps`.
  - `scheduler.ts` — pg-boss: dream 04:00 → gap analysis; briefing 08:00;
    cc-spend sweep 10m; cc-ingest sweep 15m; **user-cron tick every 1m** (runs
    due `user_crons` via `runTurnExclusive(.,"cron")` → Telegram). `notifyTelegram()`.
  - `webchat.ts` — poller draining `web_chat` (claim FOR UPDATE SKIP LOCKED →
    `runTurnExclusive(.,"web")` → write reply); requeues orphaned `running` rows
    on boot. Backs the web console chat.
  - `telegram.ts` — grammY long-poll, single-user allowlist first middleware.
    Commands `/dream /brief /gaps /model /auto /skills`. Uses `runTurnExclusive`.
    CRITICAL: never await the turn on the update loop (deadlock).
  - `edges.ts` (page-graph derivation: `structuralEdges` + LLM `linkPageRows` +
    `fetchCandidatePages`), `backfill-edges.ts` (one-shot edge backfill),
    `crons.ts` (`user_crons` CRUD + pure `dueSlot`/`dueCrons` cron matching, via
    `cron-parser`), `scheduler-tools.ts` (in-process Agent-SDK MCP `scheduler`
    server — `schedule_cron`/`list_crons`/`cancel_cron`; agent-runtime concern,
    NOT in brain-mcp), `bash-policy.ts` (`SAFE_BASH_RE`/`NETWORK_BASH_RE`,
    extracted for unit tests).
  - `cc-ingest.ts` (CC `~/.claude/projects` JSONL → `cc_sessions`),
    `ccspend.ts` (cc.sh spend spool → `spend_log`), `approvals.ts` (HMAC
    Telegram buttons, fail-closed), `sandbox.ts`, `skills.ts`, `briefing.ts`,
    `llm.ts`, `db.ts`, `config.ts`, `cli.ts`, `index.ts` (boot:
    initPolicy → scheduler → web chat poller → bot).
- `shared/` — `somnus-shared` npm package (`file:../shared` dep in both agent +
  brain-mcp): the OpenAI embeddings client, deduped out of both. Built first in
  the Docker build; `dist` copied into the runtime stage.
- `agent/tools/` — **shipped in the agent image**: `cc.sh` (in-container
  headless Claude Code sessions — subscription-billed via
  `CLAUDE_CODE_OAUTH_TOKEN`, per-owner GitHub PATs `GITHUB_TOKEN[_<OWNER>]`,
  push branches only, costs spooled), `term.sh` (SSH wrapper → workstation tmux
  bridge), `git-askpass.sh`.
- `tools/` — **host (Mac) control plane, NOT in the image**: `cc.sh`/`term.sh`
  (Mac-local originals), `term-bridge.sh` (SSH forced-command pinning the term
  bridge), `deploy.sh` (one-command deploy over Tailscale).
- `dashboard/` — web console (Express + static `public/index.html`, `graph.ts`).
  Read APIs over the brain + token-gated `/api/chat`; route bodies wrapped in an
  `apiRoute()` helper. **BMO console**: gruvbox-8-bit, a draggable pixel-art BMO
  whose screen is a live Somnus chat terminal, surrounded by draggable/resizable
  windows (memory/episodes/sessions/spend/scheduler + a **graph** window: an
  Obsidian-style hand-rolled-canvas force graph of pages=nodes / active edges=links,
  via `/api/graph` + `/api/page/:id`). Tailnet-bound (`DASHBOARD_BIND`).
- `ops/` — backup scripts (`vm/backup.sh` cron, `mac/pull-somnus-backup.sh`
  launchd). `workspace/` — agent scratch + `inbox/` (gitignored).

## Security model (first-class — Tyler's explicit priority)

Zero inbound ports (long-poll + localhost Postgres + tailnet-only SSH/dashboard;
cloud firewall is defense-in-depth, never the sole boundary). Allowlist before
any LLM call. **In production the container IS the Bash sandbox boundary**
(`BASH_AUTO_APPROVE=true` inside a locked-down container — no host secrets, no
docker socket; the OS-sandbox layer in `sandbox.ts` is for local/Mac dev).
Layered `decidePermission`: brain tools always allowed; Read/Glob/Grep except
sensitive paths; Write/Edit workspace-only; **network commands + host tools
(cc.sh/term.sh/tmux) keep a human Telegram tap even in automode**.
- **cc.sh**: GitHub PATs visible only to clone/push (sessions run `env -u`
  stripped of all `GITHUB_TOKEN*`); subscription token, not API key.
- **term bridge**: a workstation SSH key lives in the container, pinned by a
  Mac-side **forced-command** to only `term.sh list|peek|send|keys`, `from=` the
  VM IP, instantly revocable. The forced-command (not the regex) is the real
  bound on a compromised agent.
- **web chat**: token (`CHAT_TOKEN`, entered in BMO, never injected into the
  page) + tailnet gate *who* can send; tool-approval + $10/day cap still bound
  *what* a web turn can do.
- Credentials the harness must pass to Bash children (cc.sh / term bridge) go
  via 0600 files matching `SENSITIVE_PATH_RE` (Claude Code strips cred env vars
  from Bash children — discovered the hard way).
- Daily spend cap (`spend_log`). Somnus self-audited 2026-06-11
  (`research/somnus-security-research-2026-06-11.md`): 4 vulns fixed.
- **Rejected**: OpenClaw (security record); docker-socket-in-agent (Somnus
  self-added it for deploys — reverted as a host-root hole). Don't reintroduce
  either.

## Model strategy

- Chat: `claude-sonnet-4-6` default (harness carries quality; `/model` live;
  `CHAT_MODEL`). Dream: `claude-opus-4-8` (`DREAM_MODEL`) — errors compound.
  Gap analysis: Haiku classify / Sonnet research. cc.sh sessions: Sonnet
  default. Edge linking (`linkPages`/backfill): Sonnet (`config.model`) — light
  classification, cost-conscious. User crons + chat run as normal turns (chat
  model). Background/workflow agents: Haiku/Sonnet only (Tyler's pref).
- Embeddings: OpenAI text-embedding-3-small (1536d); no key → FTS-only.

## Ops runbook

- **PRODUCTION = the VM.** Hetzner CPX11 `somnus-vm` (Hillsboro; public
  5.78.45.62 / tailnet 100.96.104.68; Ubuntu). `ssh somnus-vm` (Tailscale only).
  3 containers via `docker compose --profile agent`: `db`, `agent`, `dashboard`
  (+ one-shot `migrate`). Local Mac = dev only (dummy Telegram vars; local db
  port 5433 is a dev snapshot). Never run the prod bot locally.
- Deploy: `tools/deploy.sh` (pull + rebuild + restart over Tailscale). Migrations
  auto-apply. Logs: `ssh somnus-vm 'cd ~/somnus && docker compose --profile agent
  logs -f --tail 100 agent'`. DB poke: `… docker compose exec -T db psql -U brain
  -d brain`.
- **Web console**: `http://somnus-vm:3001/` (tailnet). Sends need `CHAT_TOKEN`
  (`ssh somnus-vm 'grep CHAT_TOKEN ~/somnus/.env'`).
- VM `.env` keys beyond the basics: `OWNER_NAME`, `CHAT_TOKEN`, `DASHBOARD_BIND`
  (tailnet IP), `WORKSTATION_SSH_HOST`/`_USER` (term bridge),
  `GITHUB_TOKEN`/`GITHUB_TOKEN_NEUROTIME`, `CLAUDE_CODE_OAUTH_TOKEN`.
- Both packages `npm run build` (tsc); `cd agent && npm test`. Commit per
  feature; push to `git@github.com:tyler-grimes/somnus.git`.
- Backups: VM cron 04:30 → `/var/backups/somnus` (keep 7); Mac launchd 09:00
  pulls → `~/Backups/somnus` (keep 30).

## State of the world (2026-06-19)

**Done & live (foundation):** schema + brain-mcp + agent harness; Telegram+CLI;
researched prompt + growing persona; dream cycle; **gap analysis (chained off
dream)**; friction→skill drafting; morning briefing; embeddings; file capture;
security hardening; full-auto mode; **24/7 VM deployment** (Docker, nightly
backups, auto-migrate); **in-container cc.sh coding sessions**; **workstation
tmux term bridge**; **CC transcript ingestion**; **gruvbox 8-bit BMO web
console**; generic `OWNER_NAME`/cross-platform refactor. Treat the DB as
production data (real facts: YC application, NeuroTime work, graduation).

**Shipped this session (2026-06-13 → 06-19), all merged to main + deployed:**
- **Skill-drafting EACCES fix** — dream skills now write to
  `SKILLS_DIR=/home/node/.claude/somnus` (persistent, node-owned volume); was
  failing nightly on root-owned ephemeral `/app/.claude`.
- **Dashboard graph view** — Obsidian-style force graph (pages/edges) on BMO.
- **Edge linking** — `linkPages` dream phase + `backfill-edges`: structural
  (daily `precedes` chain, gap_analysis `raised_on` provenance) + LLM-semantic
  (`relates_to`/`duplicates`/`blocks`/`depends_on`). Populates the graph.
- **Repo-wide audit → 27 fixes** — security/correctness/resilience batch
  (Bash newline-injection gate closed, pg.Pool error handler, sensitive-path +
  network blocklist gaps, skill-slug path-traversal, idempotent views, etc.);
  security-reviewed before deploy.
- **Quality cleanup** — Batch A: DRY helpers (`fetchCandidatePages`,
  `isBudgetExhausted`, `SLUG_RE`, `apiRoute`, `textResult`) + `briefing.ts`
  UTC-timezone bug fix. Batch B: `somnus-shared` package (embeddings deduped
  across agent + brain-mcp).
- **User-defined crons** — NL → in-process SDK `scheduler` tools → `user_crons`
  → 1-minute ticker runs each as a turn → Telegram. Telegram typing → 4s.
- **Memory features** — scratchpad, `update_fact`, people (`relationship`
  kind), per-project context; all surface in `renderCoreBlocks`.

**Not done / next:**
1. Voice round-trip (Telegram voice → STT → agent → TTS); files land in inbox.
2. External ingestion (deferred): Gmail/Calendar (Google MCP), Obsidian vault.
3. Skill outcome tracking/retirement (Ratchet pattern, research §3.4) — manual.
4. WAL-G / object-storage backups (deferred; nightly pg_dump + Mac pull for now).
5. DEPLOY.md backup section + a few runbook bits still macOS-specific.
6. **cortextOS-inspired resilience (reviewed 06-18, recommended, NOT built):**
   proactive session rotation (reset the shared SDK session after each dream —
   it never proactively resets today), secret redaction on tool output/logs
   (input side is scrubbed; output isn't), liveness/dead-man's-switch + crash-loop
   alerting (today relies on Docker `restart: unless-stopped` — silent failures).
   Deliberately did NOT adopt cortextOS's loose `--dangerously-skip-permissions`
   default, file bus / multi-agent fleet, or its file KB (the brain supersedes it).

## Tyler's working preferences

- Security > convenience, but chose full-autonomy automode + the term bridge
  knowingly. Flag security-weakening changes; he decides.
- Skills over MCP for new integrations (the brain's memory MCP is the
  exception — now ~17 tools; scheduler tools live in an in-process agent SDK
  MCP, separate from the brain, since scheduling is an agent-runtime concern).
- Brainstorm → spec → plan → subagent-execute with two-stage review, then
  build/test + adversarial review before merge; deploy only when he says so.
- Haiku/Sonnet for background/workflow agents; cost-conscious.
- Build > buy: owns the brain; agent runtime replaceable.
- Commits via the assistant; messages explain *why*; co-author trailer
  "Claude Fable 5 <noreply@anthropic.com>". Brainstorm→plan→subagent-execute
  (superpowers) for features; reviews catch real bugs — keep them.
- Persistent assistant memory at
  `~/.claude/projects/-Users-tylergrimes-adhd-squared/memory/` (MEMORY.md
  index) — separate from Somnus's brain.

## Gotchas learned the hard way (don't relearn)

- Agent SDK: allow decisions MUST echo `updatedInput: input`.
- Only trust `session_id` from `subtype === "success"`; recover from "No
  conversation found" by retrying fresh.
- grammY: never block the update loop on a turn (approval deadlock).
- Shared SDK session is NOT concurrency-safe → all turns go through
  `runTurnExclusive`. Web+Telegram interleave safely because of it.
- Automode/persisted state in `settings` table — in-memory dies on restart.
- pg-boss v12: named export `{ PgBoss }`; `createQueue` before schedule/send;
  handler gets a jobs array; **job columns are snake_case** (`completed_on`,
  `started_on`, `created_on`) — the dashboard query learned this the hard way.
- Removing a `boss.schedule(...)` call does NOT delete the schedule row — call
  `boss.unschedule(name)` on boot to clear stale crons (gap-analysis did).
- **Claude Code strips credential env vars from Bash children** — hand cc.sh /
  term bridge their tokens via 0600 files, not env.
- Ubuntu sshd is socket-activated: bind via `ssh.socket` drop-in (+ `FreeBind`),
  not `sshd_config ListenAddress`. macOS Remote Login: `systemsetup` needs Full
  Disk Access — use the System Settings GUI toggle.
- Docker init scripts only run on a fresh DB → the `migrate` service applies new
  `db/init/*.sql` on existing DBs.
- Express: register `/api/chat/history` BEFORE `/api/chat/:id` (else "history"
  is captured as an id → invalid-UUID 500).
- Dashboard `index.html` resize handler must clamp-in-place, NOT re-apply the
  default layout (that wiped dragged/resized windows).
- Telegram callback `known=false` = two bot processes fighting long-poll.
- Dream SQL: GIN expression indexes need double parens; `date_trunc` on
  timestamptz isn't IMMUTABLE.
- Migrations go in `db/init/` (mounted to `/migrations`), NOT `db/migrations/`;
  number sequentially after the highest existing file (a spec asking for
  `db/migrations/002…` is wrong on both count and dir for this repo).
- The inline `CHECK (kind IN …)` on `facts` is auto-named `facts_kind_check`
  (verified on prod) — `DROP CONSTRAINT IF EXISTS facts_kind_check` + re-`ADD`
  is how you widen the kind enum.
- Container runs as `uid=1000(node)`; `/app` is root-owned + ephemeral. Anything
  the agent writes (drafted skills) must target a node-owned persistent volume —
  use `SKILLS_DIR=/home/node/.claude/somnus`, not `/app/.claude` (EACCES + lost
  on rebuild). Don't put it directly at `~/.claude/skills` — cc.sh's own Claude
  Code sessions would auto-load it.
- `somnus-shared` is a `file:../shared` dep: the Dockerfile must build `shared`
  FIRST, then agent/brain-mcp `npm ci` (symlink), then copy `shared/dist` into
  the runtime stage. Consumer **test** imports use the `.js` specifier (tsc errors
  TS5097 on `.ts`); source imports already do.
- Agent SDK in-process tools: `createSdkMcpServer({name,tools:[tool(name,desc,
  zodRawShape,handler)]})`, registered in `mcpServers` alongside `brain`; allow
  with `mcp__<name>__*` in `allowedTools` AND a `startsWith` in `decidePermission`.
- `SAFE_BASH_RE` must exclude control chars (`\n\r\t\x00-\x1f`) or a
  newline-injected second command passes as "safe" and skips the network/approval
  gate. Regexes live in `bash-policy.ts` with unit tests.
- Budget gate + briefing day windows: `date_trunc('day', now() AT TIME ZONE $tz)
  AT TIME ZONE $tz` with `config.timezone` — bare `date_trunc('day', now())` is
  UTC (the DB container has no TZ), which mis-attributes spend before UTC midnight.
- pg-boss schedules are keyed by queue name (≈ one cron per queue). For N
  user-defined crons, a single 1-minute ticker that evaluates due crons against
  the table beats registering N dynamic schedules (add/cancel = just a row write).
