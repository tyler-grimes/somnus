# HANDOFF — Somnus (adhd_squared)

> Context document for a fresh Claude Code session. Read this, then `README.md`,
> then skim `research/README.md`. Everything here was true as of 2026-06-11.

## What this is

**Somnus** — Tyler's personal, always-on second-brain agent (named for the Roman
god of sleep: its deepest work happens in the nightly "dream cycle"). Goal:
organize what Tyler works on and know him better than he knows himself.
Live and in daily use via Telegram. GitHub: `tyler-grimes/somnus` (private).

## Architecture in one paragraph

The load-bearing decision is the **brain/agent seam**: a self-owned memory
engine (single Postgres + pgvector — vectors, full-text, typed-edge graph,
bitemporal facts, job queue, all in one DB) exposed as an MCP server
(`brain-mcp/`), with a **replaceable** agent runtime on top (`agent/`, Claude
Agent SDK). The brain is the durable asset; the agent is a client. Every
architecture choice traces to adversarially-verified research in `research/`
(start with `research/README.md`; 9+ reports, claims tagged with 3-vote
verification results).

## Repo layout

- `db/init/001_schema.sql` — full schema: `pages`, `content_chunks`
  (HALFVEC(1536) + HNSW), bitemporal `facts` (valid_from/valid_until +
  recorded_at/superseded_at; kinds incl. `persona`), typed `edges`,
  append-only `episodes`, `friction_events`, `command_rules`, `settings`,
  `spend_log`. Postgres runs via `docker-compose.yml` (pgvector/pg17,
  localhost-only; **local dev port 5433**, 5432 was taken).
- `brain-mcp/` — stdio MCP server, 6 tools: `search_memory` (hybrid RRF
  FTS+vector when OPENAI_API_KEY set, FTS/trigram fallback), `remember_fact`,
  `supersede_fact` (contradiction = close old row, never delete),
  `core_blocks`, `recent_episodes`, `log_friction`. Write-time embeddings via
  OpenAI text-embedding-3-small.
- `agent/src/` — the harness:
  - `agent.ts` — turn loop (`runAgentTurn`), system prompt (researched design,
    see `research/system-prompt-design.md`), Letta-style core blocks rendered
    from `facts` each turn (persona facts first), layered `decidePermission`,
    live-switchable chat model, session resume w/ stale-session recovery.
  - `dream.ts` — nightly consolidation (04:00 local, pg-boss): extract facts →
    resolve contradictions → daily reflection page → **persona evolution**
    (Somnus's self-description grows, cap 8 facts, ≤1 revision + 1 addition per
    night) → friction clustering (union-find on trigram similarity) → skill
    drafting (3+ similar events → SKILL.md in `.claude/skills-pending/`) →
    embedding backfill → decay + purge. Ingested (non-Tyler) content is
    spotlighted as untrusted in extraction; derived facts get confidence ≤0.4
    and source `dream:extract:ingested` (kept out of core blocks).
  - `scheduler.ts` — pg-boss (queue lives in the same Postgres; no Redis).
    Dream 04:00, morning briefing 08:00, `notifyTelegram()` for proactive push.
  - `telegram.ts` — grammY long-polling, **single-user allowlist as first
    middleware** (silent drop). Commands: `/dream`, `/brief`, `/model
    fable|opus|sonnet|haiku`, `/auto on|N|off`, `/skills [approve|reject
    <slug>]`. File/photo/voice uploads → `workspace/inbox/` + page + episode.
    CRITICAL: the text handler must never await the agent turn (grammY
    processes updates sequentially — blocking starves approval callbacks;
    deadlock fixed in 59d2969).
  - `approvals.ts` — Telegram Approve/Always/Full-auto/Deny buttons; HMAC-signed
    callback tokens; fail-closed on timeout (5 min) or unreachable Telegram.
  - `sandbox.ts` — OS-level Bash containment (Seatbelt/bubblewrap via SDK
    sandbox settings): writes confined to workspace, secret paths unreadable,
    `env -i` scrub so dumps see no keys; subprocess env scrubbed of
    Telegram/DB/OpenAI secrets. The regex blocklist is a pre-filter, NOT the
    boundary — the sandbox is.
  - `skills.ts` — skill lifecycle: drafts in `.claude/skills-pending/`, Tyler
    approves via `/skills approve` → `.claude/skills/`; active skills'
    frontmatter (~100 tokens each) injected into the system prompt, bodies
    Read on demand. Human gate is deliberate (ungated self-skills ≈ 0 gain
    per research) — do not auto-approve.
  - `briefing.ts`, `llm.ts` (direct Anthropic SDK + zod structured outputs +
    spend logging), `embeddings.ts`, `db.ts`, `config.ts`, `cli.ts`
    (`npm run cli`), `index.ts` (boot: initPolicy → scheduler → bot).
- `tools/cc.sh` + `tools/term.sh` + `tools/term-bridge.sh` — Mac host tools.
  `term-bridge.sh` is the SSH forced-command that lets the VM drive the Mac's
  tmux: the container's `agent/tools/term.sh` SSHes over Tailscale with a
  dedicated key (host file `/home/somnus/.ssh/term-bridge`, bind-mounted ro),
  and the Mac authorized_keys entry pins term-bridge.sh which allow-lists
  list|peek|send|keys → real term.sh. `agent/tools/cc.sh` = in-container
  Claude Code sessions (see its own notes). ALL cc.sh/term.sh/tmux calls are
  ALWAYS human-gated, never automode or standing rules. Setup: DEPLOY.md §9.
- `workspace/` — agent's scratch dir (gitignored); `workspace/inbox/` receives
  Telegram uploads.

## Security model (first-class requirement — Tyler's explicit priority)

Zero inbound ports (long-poll + localhost Postgres). Allowlist before any LLM
call. Layered `decidePermission`: brain tools always allowed; Read/Glob/Grep
anywhere except sensitive paths; Write/Edit workspace-only; **Bash = OS
sandbox + approval** (safe read-only commands auto-allow; "Always" rules
prefix-match from `command_rules`; `/auto` = persistent global automode in
`settings` table — but network-touching commands and host tools keep a human
tap even in automode). Sensitive-path blocklist is absolute (applies in
automode). Daily spend cap (`spend_log`, default $10). Somnus self-audited
2026-06-11 (`research/somnus-security-research-2026-06-11.md`): 4 vulns found
and fixed (sandbox, ingestion trust boundary, HMAC tokens, visibility
enforcement) — commits 224bd12..c304cce. Tyler rejected OpenClaw over its
security record; don't suggest adopting external agent gateways.

## Model strategy (modular by design)

- Chat: `claude-sonnet-4-6` default — the harness (memory + core blocks)
  carries quality; `/model` switches live; `CHAT_MODEL` env.
- Dream cycle: `claude-opus-4-8` (`DREAM_MODEL`) — consolidation errors
  compound, so the powerful model goes here. This inversion is deliberate.
- Workflow/background agents in dev sessions: Tyler wants Haiku/Sonnet only.
- Embeddings: OpenAI text-embedding-3-small (1536d). No key → graceful
  FTS-only degradation.

## Ops runbook

- PRODUCTION = the VM (`ssh somnus-vm`, Tailscale only). Local Mac is dev
  only: local `.env` has DUMMY Telegram vars (prod token lives only in VM
  `.env`); local db (port 5433) is a dev sandbox snapshot as of migration.
  Never run the prod bot locally.
- Local secrets in root `.env` (gitignored; template `.env.example`);
  DATABASE_URL needs a literal password — node --env-file does NO
  interpolation. OPENAI_API_KEY present (vector arm live, both machines).
- VM ops: deploy with `tools/deploy.sh`; logs `ssh somnus-vm 'cd ~/somnus &&
  docker compose --profile agent logs -f --tail 100 agent'`. Local dev: CLI
  via `cd agent && npm run cli` against local db.
- Both packages build with `npm run build` (tsc). Keep builds green; commit
  per feature; push to origin (`git@github.com:tyler-grimes/somnus.git`).
- DB poke: `docker compose exec -T db psql -U brain -d brain`.

## State of the world (2026-06-11)

Done: schema, brain-mcp, agent harness, Telegram+CLI, researched system
prompt + growing persona, dream cycle (verified end-to-end), friction→skill
drafting, morning briefing (tested against real data), embedding pipeline,
file capture, cc.sh/term.sh control plane, security hardening, full-auto mode.
Real usage exists: actual facts/commitments in the brain (YC application,
NeuroTime work, graduation) — treat the DB as production data.

Not done / next:
1. `OPENAI_API_KEY` into `.env` if still absent (biggest retrieval win).
2. Voice round-trip (Telegram voice → STT → agent → TTS); voice files already
   land in inbox. Whisper API = boring-correct default; vendor not chosen.
3. Ingestion (deferred by Tyler — "nothing to ingest yet"): Google MCP
   (Gmail draft/label, Calendar full CRUD), Obsidian vault sync. Research in
   `research/gap-fill-letta-voice-ingestion.md` + main report §4.
4. VM deployment: **DONE 2026-06-11.** Somnus runs 24/7 on Hetzner CPX11
   `somnus-vm` (Hillsboro, 5.78.45.62 public / 100.96.104.68 tailnet,
   Ubuntu 26.04). Prod Telegram token lives ONLY there; local `.env` has
   dummies so `npm run cli` still works. Backups: VM cron 04:30 →
   `/var/backups/somnus` (keep 7), Mac launchd 09:00 pulls →
   `~/Backups/somnus` (keep 30). Deploys: `tools/deploy.sh`. Runbook:
   `docs/DEPLOY.md`. WAL-G/object storage still deferred.
5. Skill outcome tracking/retirement (Ratchet pattern, research §3.4) —
   currently manual monthly review.

## Tyler's working preferences (matter for any session)

- Security > convenience, but he chose full-autonomy automode knowingly.
- Skills over MCP for new integrations (token efficiency); brain's 6-tool MCP
  is the agreed exception.
- Haiku/Sonnet for background/workflow agents; cost-consciousness generally.
- Build > buy: owns the brain; agent runtime replaceable by design.
- He commits via the assistant; commit messages explain *why*; co-author
  trailer "Claude Fable 5 <noreply@anthropic.com>".
- Persistent assistant memory also lives at
  `~/.claude/projects/-Users-tylergrimes-adhd-squared/memory/` (MEMORY.md
  index) — separate from Somnus's brain; don't confuse the two.

## Gotchas learned the hard way (don't relearn)

- Agent SDK: allow decisions MUST echo `updatedInput: input` (undefined =
  validation failure = every tool blocked).
- Only trust `session_id` from `subtype === "success"` results; recover from
  "No conversation found" by retrying fresh (agent.ts does this).
- grammY: never block the update loop on a turn (approval deadlock).
- Automode/persisted state lives in `settings` table — in-memory-only state
  dies on every restart and reads as "feature broken".
- pg-boss v12: named export `{ PgBoss }`, `createQueue` before
  `schedule`/`send`, handler receives a jobs array.
- `zodOutputFormat(schema)` — one argument. `client.messages.parse` +
  `parsed_output` for structured extraction.
- Telegram callback buttons: if taps log `known=false`, two bot processes are
  fighting over long-poll updates (`ps aux | grep dist/index.js`).
- Dream-cycle SQL: GIN expression indexes need double parens; `date_trunc` on
  timestamptz is not IMMUTABLE (can't index).
