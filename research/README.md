# Second-Brain Architecture Research — Index

**Date:** 2026-06-10. Three reports, produced by multi-agent deep-research runs with 3-vote adversarial claim verification (claims that failed verification are listed in each report's "Refuted claims"/caveats sections).

## Reports

1. **[second-brain-architecture-report.md](./second-brain-architecture-report.md)** — main report. Agentic frameworks, memory layers, self-improvement/skill-learning research (MUSE-Autoskill, SkillsBench, Ratchet), ingestion via MCP, recommended architecture + build order. 21 verified claims, 4 refuted.
2. **[gbrain-analysis.md](./gbrain-analysis.md)** — full code teardown of garrytan/gbrain (commit `03ffc6eb`). 13-item "steal this" list, skip list, mermaid data-flow diagrams.
3. **[gap-fill-letta-voice-ingestion.md](./gap-fill-letta-voice-ingestion.md)** — second verification round on the gaps: Letta 2026 honest assessment, voice pipelines (Pipecat+Mem0), Telegram bot layer, iMessage/Slack ingestion. 25 verified claims.
4. **[brain-architecture.md](./brain-architecture.md)** — what good brain architecture looks like: five memory types, CoALA/HippoRAG/Engram lessons, bi-temporal contradiction resolution, forgetting/decay classes, 12-phase dream cycle, always-in-context blocks. Ends with blueprint mapping principles onto this system.
5. **[database-selection.md](./database-selection.md)** — DB verdict: single Postgres + pgvector (halfvec HNSW), tsvector+GIN FTS with RRF hybrid in pure SQL, typed-edge tables + recursive CTEs over a graph DB, pg-boss/Procrastinate job queue. Ends with complete CREATE TABLE-level schema for build-order step 1. 29 verified / 11 refuted claims across both reports.
6. **[graph-db-vs-relational-verdict.md](./graph-db-vs-relational-verdict.md)** — answers "aren't graph DBs optimal for LLMs?": graph-structured retrieval (data model) is genuinely valuable; a native graph engine (storage software) is separable and unnecessary at personal scale — most leading GraphRAG systems don't use one. Names concrete trigger conditions for adding an engine later.
7. **[falkordb-assessment.md](./falkordb-assessment.md)** — FalkorDB deep-dive: legit GraphBLAS engine + verified Graphiti/GraphRAG-SDK/vector integrations; all headline vs-Neo4j benchmark numbers refuted; RAM-resident Redis-module ops model + SSPLv1. If a graph engine is ever needed: Kuzu unless Graphiti is a hard requirement.

## Bottom line

Build a **harness, not a model wrapper**. Separate the two halves:

- **Brain (the moat, yours forever):** single Postgres + pgvector on the cloud VM — pages/chunks, full-text + vector hybrid retrieval, typed edges, temporal facts with provenance (the dedicated user-model layer), friction log, job queue. Exposed over MCP.
- **Agent runtime (replaceable):** Claude Agent SDK. Skills kept in the open SKILL.md standard as the migration hedge. Telegram (long-polling), CLI (ssh), and voice (voice-note → STT → same agent → TTS) are all thin clients of the one always-on agent.
- **Self-improvement comes last, and gated:** nightly dream cycle clusters friction logs → drafts skills → unit-test gate → registers only on pass → tracks outcomes → retires losers → bounded active cap → monthly human curation. Naive self-authored skills measure ≈ zero gain; the gates are what make the loop net-positive.
- **Letta:** don't return to the platform (self-host surface deprecated, Cloud = $20/mo floor + brain leaves your control). Steal its two best ideas: bounded always-in-context memory blocks rendered from the facts table, and sleep-time consolidation (= the dream cycle).

## Build order

1. Postgres schema + facts/user-model tables + `~/inbox/` capture folder
2. Claude Agent SDK loop + Telegram long-polling bot
3. Google-managed MCP (Gmail draft/label, Calendar full CRUD) + Obsidian vault sync
4. Nightly dream cycle (sync → extract facts → consolidate → reflect → embed → purge)
5. Friction/failure logging
6. Governed skill-creation loop (last — net-negative without the gates above)

Hard-source ingestion when ready: BlueBubbles on an always-on Mac → webhooks to VM (iMessage real-time), imessage-exporter for backfill, personal xoxp Slack app for full history export.
