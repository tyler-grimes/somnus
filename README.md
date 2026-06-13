```
                              .                 *           .
        *           .                  .             .            *
   ███████╗ ██████╗ ███╗   ███╗███╗   ██╗██╗   ██╗███████╗    .      (
   ██╔════╝██╔═══██╗████╗ ████║████╗  ██║██║   ██║██╔════╝          )  )
   ███████╗██║   ██║██╔████╔██║██╔██╗ ██║██║   ██║███████╗      .  (  (
   ╚════██║██║   ██║██║╚██╔╝██║██║╚██╗██║██║   ██║╚════██║         _)_)_
   ███████║╚██████╔╝██║ ╚═╝ ██║██║ ╚████║╚██████╔╝███████║       ((     ))   zzz
   ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝        (  ___  )
        a second brain that does its best work while you sleep     `-----'
```

> **Somnus** — Roman god of sleep. The agent is awake all day on Telegram, but
> its deepest work happens at 4 a.m., when the **dream cycle** consolidates the
> day into durable memory, evolves its own persona, and surfaces the gaps you
> didn't notice. You wake up to a briefing.

A single-user, always-on personal agent built on a **self-owned memory engine**.
One Postgres holds everything — vectors, full-text, a typed-edge graph,
bitemporal facts, and the job queue. That brain is the durable moat; the agent
runtime on top is deliberately replaceable. Lives 24/7 on a tiny VM, reachable
only over Telegram and a private tailnet — **zero inbound ports**.

Every architecture choice traces to adversarially-verified research in
[`research/`](research/README.md).

---

## What it does

🧠 **Remembers** — every conversation becomes episodes; the dream cycle distills
them into bitemporal facts (contradictions close old rows, never delete), a
growing self-persona, and an embedded, hybrid-searchable knowledge graph.

🌙 **Dreams** — nightly at 04:00 (Opus): extract facts → resolve contradictions
→ write a daily reflection → evolve its persona → cluster recurring friction →
draft new skills → backfill embeddings → decay & purge. Then it **chains gap
analysis**: research the open questions the day left behind and ping you only on
the high-priority ones.

☀️ **Briefs** — 08:00 every morning: commitments, open threads, spend.

💻 **Codes** — delegates real work to headless Claude Code sessions *inside its
own container* (`cc.sh`): clones your repos, branches off fresh `main`, pushes a
feature branch, and hands you a compare URL to merge. Billed to a Claude
subscription, not the API.

⌨️ **Reaches your desk** — over a locked-down SSH bridge it can drive the live
tmux sessions on your computer (`term.sh`, any sshd+tmux host — macOS, Linux,
WSL): read a pane, answer a Claude Code session's prompt, send control keys.
Every keystroke is one Telegram approval.

📊 **Shows itself** — a small web dashboard (tailnet-only) over the brain.

🔒 **Stays yours** — you own the database, the agent, and every credential. No
external agent gateway, no cloud memory service.

---

## Architecture

```
   Telegram  ──long-poll──►  ┌────────────────────────────┐
   (you, allowlisted)        │  agent  (Claude Agent SDK)  │
                             │  • turn loop + core blocks  │
  your tmux  ◄──term.sh────► │  • layered permission gate  │      ┌──────────────┐
   (SSH bridge, gated)       │  • dream / brief / gaps     │◄────►│  brain (MCP) │
                             │  • cc.sh coding sessions    │ stdio│  6 tools     │
   GitHub    ◄──cc.sh──────► │  • pg-boss scheduler        │      └──────┬───────┘
   (branch + PR)             └────────────────────────────┘             │
                                                                  ┌──────▼───────┐
                                                                  │  Postgres    │
                                                                  │  pgvector ·  │
                                                                  │  FTS · graph │
                                                                  │  facts · jobs│
                                                                  └──────────────┘
        single VM · Tailscale-only SSH · containers are the sandbox boundary
```

- **`db/`** — the memory engine schema: `pages`, `content_chunks` (HALFVEC +
  HNSW), bitemporal `facts`, typed `edges`, append-only `episodes`,
  `friction_events`, `cc_sessions`, `spend_log`. Migrations applied on deploy by
  a one-shot `migrate` service.
- **`brain-mcp/`** — the seam: the memory engine as a 6-tool stdio MCP server
  (`search_memory`, `remember_fact`, `supersede_fact`, `core_blocks`,
  `recent_episodes`, `log_friction`). Any agent runtime can plug in.
- **`agent/`** — the replaceable runtime: turn loop, Letta-style core blocks
  rendered from facts each turn, layered `decidePermission`, dream cycle,
  scheduler, Telegram gateway, `cc.sh`/`term.sh` bridges.
- **`dashboard/`** — read-only web view over the brain (tailnet-bound).
- **`tools/`** — host control plane (`cc.sh`, `term.sh`, `term-bridge.sh`,
  `deploy.sh`). **`ops/`** — backup scripts.
- **`research/`** — verified reports behind every decision.

---

## Security model

Security is a first-class requirement, not a feature.

- **Zero inbound ports.** Long-poll + localhost Postgres; SSH bound to the
  tailnet only; a deny-all cloud firewall as backup, never as the sole boundary.
- **Single-user allowlist** before any LLM call — everyone else is silently
  dropped.
- **The container is the sandbox boundary.** In production Bash auto-approves
  *inside* a locked-down container with no host secrets and no docker socket;
  network commands and host tools (`cc.sh`/`term.sh`) still take a human tap
  even in full-auto mode.
- **Layered permission gate:** brain tools always allowed; Read/Glob/Grep except
  sensitive paths; Write/Edit workspace-only; secrets handed to bridges via
  0600 files the agent can't read.
- **The workstation bridge can only run `term.sh`** — an SSH forced-command pins it,
  scoped to the VM's tailnet IP, instantly revocable.
- HMAC-signed approval tokens · daily spend cap · ingested content spotlighted
  as untrusted · append-only episode audit log · nightly DB backups pulled
  off-box.

Somnus self-audited its own codebase (`research/somnus-security-research-*.md`)
— 4 vulnerabilities found and fixed.

---

## Status

| | |
|---|---|
| Memory engine (Postgres + pgvector, hybrid RRF search, typed graph) | ✅ live |
| Agent runtime (Claude Agent SDK + Telegram + CLI, researched system prompt) | ✅ live |
| Dream cycle → persona evolution → friction clustering → skill drafting | ✅ live |
| Gap analysis (chained off the dream cycle) + morning briefing | ✅ live |
| In-container Claude Code coding sessions (`cc.sh`, subscription-billed) | ✅ live |
| Workstation tmux control bridge (`term.sh` over Tailscale, forced-command) | ✅ live |
| Web dashboard (tailnet) · CC transcript ingestion · auto-migrations | ✅ live |
| 24/7 VM deployment (Hetzner, Docker, nightly backups) | ✅ live |
| Voice round-trip (Telegram voice → STT → agent → TTS) | ⏸ planned |
| External ingestion (Gmail/Calendar, Obsidian vault) | ⏸ deferred |

---

## Run it

**Memory engine:**
```sh
cp .env.example .env        # set DB_PASSWORD
docker compose up -d db     # schema applies on first start
```

**Agent (local dev):**
```sh
# .env: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, DATABASE_URL
(cd brain-mcp && npm install && npm run build)
(cd agent && npm install && npm run build && npm run cli)   # CLI REPL
```

**Production (VM):** see [`docs/DEPLOY.md`](docs/DEPLOY.md) — provisioning,
migration, the term bridge, and `tools/deploy.sh` for one-command deploys.

The bot answers only your Telegram user ID. Everyone else is silently dropped.
