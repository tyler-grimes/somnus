# adhd² — personal second brain

An always-on personal agent with a self-owned memory engine. The brain (single
Postgres: vectors + full-text + typed-edge graph + bitemporal facts + job queue)
is the durable moat; the agent runtime on top is replaceable.

Full architecture rationale, verified research, and build order: [research/README.md](research/README.md).

## Quickstart (memory engine)

```sh
cp .env.example .env   # set DB_PASSWORD
docker compose up -d db
docker compose exec db psql -U brain -d brain -c '\dt'
```

Schema applies automatically on first start from `db/init/001_schema.sql`.

## Quickstart (agent)

```sh
# 1. Fill in .env: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN (from @BotFather),
#    TELEGRAM_ALLOWED_USER_ID (your numeric id — ask @userinfobot), DATABASE_URL
# 2. Build both packages
(cd brain-mcp && npm install && npm run build)
(cd agent && npm install && npm run build)
# 3. Run
cd agent && npm start
```

The bot answers only your Telegram user ID; everyone else is silently dropped.

## Layout

- `db/init/` — memory engine schema (pages, content_chunks, facts, edges, episodes, friction_events, spend_log)
- `brain-mcp/` — the seam: memory engine exposed as an MCP server (search_memory, remember_fact, supersede_fact, core_blocks, recent_episodes)
- `agent/` — replaceable agent runtime: Claude Agent SDK loop + Telegram long-polling gateway. Tool surface is brain-only; budget-gated; episodes + spend logged
- `docker-compose.yml` — single-VM deployment; Postgres is the only stateful service
- `research/` — verified research reports behind every architecture decision

## Security model

Zero inbound ports (long-polling + localhost-bound Postgres) · hard single-user
allowlist before any LLM call · agent tool surface restricted to brain MCP tools
(no shell, no filesystem, no web) with `canUseTool` deny-by-default · isolated
from user/project Claude settings (`settingSources: []`) · daily spend cap ·
append-only episode audit log.

## Build order

1. ✅ Postgres schema + compose
2. ✅ Agent runtime (Claude Agent SDK) + Telegram bot + CLI + always-in-context core blocks
3. ⏸ Ingestion: Google MCP (Gmail/GCal), Obsidian vault sync, inbox capture folder (deferred — nothing to ingest yet)
4. ✅ Nightly dream cycle (pg-boss, 04:00 local; `/dream` to trigger manually): extract facts → resolve contradictions → daily reflection → cluster friction → draft skills → decay + purge → Telegram report
5. ✅ Friction logging (`log_friction` brain tool + automatic logging of failed turns)
6. ✅ Skill drafting, human-gated: 3+ similar friction events → SKILL.md draft in `.claude/skills-pending/` for review. Activation, outcome tracking, and retirement stay manual — ungated self-authored skills measure ≈ zero gain (research/second-brain-architecture-report.md §3.4)
7. Voice interface (Telegram voice notes → STT → agent → TTS) — needs STT/TTS vendor pick
