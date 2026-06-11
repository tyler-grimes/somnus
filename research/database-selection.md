# Database Selection and Schema Design

**Date:** 2026-06-10
**Method:** Multi-source research with 3-vote adversarial claim verification. Verified claims tagged with vote tallies. Engineering judgment sections clearly flagged. Companion documents: [second-brain-architecture-report.md](./second-brain-architecture-report.md), [gbrain-analysis.md](./gbrain-analysis.md).
**Scope:** Postgres + pgvector at personal scale; hybrid search inside Postgres; dedicated vector-DB trade-offs; graph layer options; job queue options; ops and backup; a concrete CREATE TABLE-level schema sketch.

---

## Executive Summary

For a single-user second brain on a cloud VM, Postgres with pgvector is not a compromise — it is the correct first-principles choice. A personal memory engine at ten thousand to a few hundred thousand chunks fits entirely in RAM on any modern instance. Transactional consistency between embeddings and metadata is a real benefit that a split-system approach (Postgres + Qdrant) actively trades away. The operational overhead of a second process is not worth the query-per-second headroom it would add at a scale you will never reach as one person. Everything — vectors, full-text search, graph edges, temporal facts, job queue, spend log, friction log — goes in one Postgres database. That is the gbrain lesson confirmed by first principles, and it is the right answer here.

---

## 1. Postgres + pgvector at Personal Scale

### Capabilities

pgvector supports **HNSW indexing without requiring training data**, using parameters `m` (default 16) and `ef_construction` (default 64). [vote 3-0, https://github.com/pgvector/pgvector] This matters because memory systems receive data in a continuous stream; you cannot bulk-train an IVF-style index and you should not have to. HNSW updates incrementally as rows are inserted.

Storage is concrete and plannable: **each standard vector costs `4 × dimensions + 8 bytes`; half-precision `vector` (`halfvec`) costs `2 × dimensions + 8 bytes`**. [vote 3-0, https://github.com/pgvector/pgvector] At 1024 dimensions, full-precision costs ~4.1 KB/chunk; half-precision costs ~2.1 KB/chunk. For 100k chunks either fits under 1 GB of vector storage alone — trivially within the RAM profile of a $20-$40/month VM.

pgvector stores **vectors in the same table as application data, in atomic transactions**, so your chunk text, metadata, and embedding are always consistent. [vote 3-0, https://encore.dev/articles/pgvector-vs-qdrant] A failed embedding write rolls back the whole row. With a split system (Postgres + external vector DB), you get eventual consistency and orphaned vectors when sync fails. [vote 2-1, https://encore.dev/articles/pgvector-vs-qdrant]

pgvector **enables hybrid search by integrating vector columns with full-text search and JOINs on the same tables**, supporting queries that combine semantic and keyword matching in a single round-trip. [vote 2-1, https://github.com/pgvector/pgvector]

pgvector 0.8.0 improved **query estimation for ANN index selection**, letting the planner choose B-tree or other non-ANN indexes for filtered queries when they would achieve better recall. [vote 3-0, https://www.postgresql.org/about/news/pgvector-080-released-2952/] Non-ANN indexes on filtered queries achieve **100% recall**, while HNSW trades some recall for speed. [vote 3-0, same source] At personal scale (recall matters more than p99 throughput) this is a straightforward win.

### Real Limits

pgvector is limited to **vertical scaling, with a practical ceiling in the low millions of vectors** on a single instance. [vote 2-1, https://encore.dev/articles/pgvector-vs-qdrant] Qdrant supports distributed horizontal scaling to hundreds of millions. For one person writing thousands of notes and emails per year, the realistic vector count after five years is still under 2M. This limit is not real at personal scale. If the system ever graduates to multi-user or corpus-scale ingestion, revisiting that constraint makes sense — but not before.

One practical limit that is real: **HNSW indexes are memory-mapped and held in RAM by the shared buffer pool**. Plan your VM's RAM allocation with the index size in mind. At 100k chunks at 1024d (half-precision): ~200MB index. At 1M chunks: ~2GB. Size the instance accordingly.

---

## 2. Hybrid Search Inside Postgres

### tsvector (Built-in FTS) vs ParadeDB BM25

Postgres's built-in `tsvector` + `tsquery` with GIN indexes provides lexeme-based term matching. It handles stemming, stop words, and weighted fields (A/B/C/D weights on `setweight`). This is what gbrain uses and it is sufficient for a personal second brain.

**ParadeDB** implements **BM25 as a native PostgreSQL index type** with query optimization supporting WHERE clause pushdown and faceting aggregations — eliminating the external synchronization risk of Elasticsearch. [vote 2-1, https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual] BM25 scores with TF-IDF term saturation (k1, b parameters) tend to outperform raw tsvector ranking (`ts_rank`) on longer documents and more heterogeneous corpus sizes, which is the typical shape of a personal memory corpus (short message fragments mixed with long meeting transcripts).

**Engineering judgment:** For a v1 build, start with `tsvector` + GIN — it has zero additional dependencies. ParadeDB adds a native Postgres extension (`pg_search`) that requires a build or a managed provider that supports it. The BM25 quality difference will be noticeable if you ingest long documents heavily. Plan the switch as a schema migration, not an architectural change — both approaches expose the same SQL query surface.

**Note:** An earlier claim that `pg_search` provides atomic backup with the data index (no separate replication strategy needed) was refuted 1-2 in adversarial verification. Treat backup of ParadeDB indexes as a separate concern and verify with the current extension docs before production use.

### Reciprocal Rank Fusion (RRF) in SQL

RRF is computed in pure SQL: give each candidate row a score `1 / (K + rank_position)` from each arm (FTS rank, vector distance), then sum across arms. K=60 is the standard value (gbrain uses it; it dampens the influence of very high ranks). The SQL pattern:

```sql
WITH fts AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(fts_vector, query) DESC) AS rk
  FROM content_chunks, plainto_tsquery('english', $1) query
  WHERE fts_vector @@ query
  LIMIT 200
),
vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rk
  FROM content_chunks
  ORDER BY embedding <=> $2::vector
  LIMIT 200
)
SELECT COALESCE(fts.id, vec.id) AS id,
       COALESCE(1.0/(60+fts.rk), 0) + COALESCE(1.0/(60+vec.rk), 0) AS rrf_score
FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
ORDER BY rrf_score DESC
LIMIT 20;
```

Add boosts as multipliers on `rrf_score` (gbrain applies 2.0× for `compiled_truth` chunks, log-scale backlink boost, recency decay). This stays pure SQL with no external service. [Engineering judgment — pattern derived from gbrain teardown and standard RRF literature]

---

## 3. When a Dedicated Vector DB Would Win

| Criterion | pgvector | Qdrant / LanceDB / sqlite-vec |
|---|---|---|
| Vector count | < 2–5M (single instance) | 10M+ (Qdrant with sharding) |
| Consistency model | Transactional (same DB) [3-0] | Eventual (separate sync) [2-1] |
| Ops overhead | One process, one backup | Two processes, two backups |
| Metadata filtering | SQL (full power) | Qdrant payload filters (good but proprietary) |
| HNSW index updates | Incremental, no retraining [3-0] | Same for Qdrant/LanceDB |
| Hybrid search | Native with FTS (SQL) [2-1] | External or limited |
| Embedding dimensions | Up to 16,000 (pgvector) | Qdrant: up to 65,535 |
| RAM for 1M × 1024d | ~2GB HNSW index | Qdrant: comparable |

Qdrant's headline advantage — distributed horizontal scaling — is irrelevant at single-user scale. Its real disadvantage is the consistency risk. [vote 2-1, https://encore.dev/articles/pgvector-vs-qdrant]

sqlite-vec and LanceDB are attractive for embedded/offline use cases (laptop, no server). The earlier refuted claim that "LanceDB-Go achieves 6ms p50 at 100k vectors" and that "embedded DBs become impractical above 10M vectors" were both refuted (1-2 and 0-3 respectively) — treat embedded-DB latency and scale claims as unverified. For a cloud VM with Postgres already running, the embedded path adds no benefit.

**Verdict:** At single-user scale, the dedicated vector DB does not win. pgvector is the correct choice. Revisit if you move past 2M chunks with aggressive recall SLAs, or if multi-tenant access requires isolation by vector space.

---

## 4. Graph Layer

### Option A: Typed-Edge SQL Tables + Recursive CTEs (Recommended)

A `links` (or `edges`) table with columns `(from_id, to_id, link_type, valid_from, valid_until, confidence, source)` is sufficient for relationship modeling. Recursive CTEs (`WITH RECURSIVE`) traverse multi-hop paths inside Postgres. This is what gbrain ships and it handles entity-relationship queries (who worked at X, what did I invest in, who introduced me to Y) without an additional process.

Limitations: recursive CTE performance degrades at deep traversals (5+ hops) on large graphs, and there is no native graph algorithm library (PageRank, community detection require external computation or extensions). For a personal second brain with a few thousand entity nodes and tens of thousands of edges, this is never the bottleneck.

### Option B: Apache AGE

Apache AGE is a Postgres extension that adds openCypher query support inside Postgres. It uses internal Postgres tables for graph storage. [Engineering judgment — no adversarially verified claims for AGE performance at this scale.] Pros: Cypher is expressive for graph patterns; no separate process. Cons: AGE has had stability issues in prior years and is slower than specialized graph engines. If the SQL-typed-edge approach produces unmaintainable queries, AGE is the next natural step without breaking the single-Postgres constraint.

### Option C: KuzuDB (Embedded) or FalkorDB / Neo4j (External)

KuzuDB uses **factorized execution to compress intermediate results 50–100× in multi-hop graph queries** compared to traditional join-based execution. [vote 3-0, https://vela.partners/blog/kuzudb-ai-agent-memory-graph-database] It is an embedded database (like SQLite) that can run in the same process. Relevant for complex graph workloads but adds a second storage system and complicates backup.

**FalkorDB performance claims ("496× faster P99 than traditional options," "sub-millisecond responses") were refuted 0-3 in adversarial verification** — do not build on those numbers. [see Refuted Claims table]

Neo4j adds a full server process and licensing considerations; overhead is unjustified at personal scale.

### Graphiti Compatibility

Graphiti (Zep's graph engine, Apache 2.0) stores **temporal knowledge graph edges with validity intervals** and updates in real-time as new information arrives — unlike GraphRAG's batch-processing model. [vote 2-1, https://blog.getzep.com/graphiti-knowledge-graphs-falkordb-support/] Graphiti requires a graph database backend. As of mid-2026, it supports Neo4j and FalkorDB backends (FalkorDB added as an alternative to Neo4j). It does not use Postgres as its graph store.

**Adding Graphiti later** means accepting a second database process (Neo4j or FalkorDB). This is the right trade if relationship/temporal traversal becomes a first-class use case — e.g., "show me how my relationship with X evolved over the last year" with bidirectional link weights and validity intervals. For v1, the typed-edge SQL table approach gets you 80% of the value with zero added ops complexity.

**Design advice (engineering judgment):** define your `link_type` enum to be compatible with Graphiti's relationship schema from the start. If you add `valid_from`/`valid_until` to the edges table and capture provenance, a migration to an external graph engine later is a data export + reimport, not a redesign.

---

## 5. Job Queue

gbrain's analysis (companion doc §8.2) established the pattern clearly: a **Postgres-native job queue** in a `minion_jobs` table eliminates Redis as a dependency. The queue features that matter for a dream cycle and ingestion daemon are: leases with TTL (stall detection), exponential backoff with jitter, idempotency keys, parent-child job trees, quiet-hours support, and token-usage accounting columns.

| Option | Pros | Cons |
|---|---|---|
| **pg-boss** (Node/TS) | Battle-tested Postgres queue; leases, backoff, cron scheduling, dead-letter; 1 dependency | TS/Node specific; cron support via pg-boss scheduler |
| **Procrastinate** (Python) | Mature Postgres queue for Python; async-native; deferred jobs, cron, retries | Python only |
| **River** (Go) | Modern Postgres queue (2024); high throughput; unique jobs, workflows | Go only |
| **Custom schema** (gbrain pattern) | Full control; schema visible in same migrations; no external lib behavior surprises | You own all the edge cases |
| **Redis + BullMQ** | Mature ecosystem; visibility, dashboards | Extra process, extra backup, extra ops |

**Engineering judgment:** For a TypeScript codebase (the recommended path from the architecture report), pg-boss is the obvious choice. For Python, Procrastinate. Either way, the queue runs against the same Postgres instance as your memory tables. Never add Redis just for a queue at this scale.

---

## 6. Ops: Backup Strategy and Docker Compose Layout

### Backup Strategy (Engineering Judgment)

Single Postgres = single backup target. `pg_dump` or `pg_basebackup` nightly covers vectors, FTS indexes, graph edges, facts, job queue, and friction log atomically. The recommended approach:

1. **Continuous WAL archiving** to cheap object storage (S3-compatible, e.g., Backblaze B2 or Cloudflare R2): enables point-in-time recovery (PITR) to any moment in the last N days. Use `pg_basebackup` + WAL archive, or a managed tool like `pgbackup` / `barman` / `wal-g`.
2. **Nightly `pg_dump` to compressed SQL** (`.gz` or `.zst`) alongside the WAL archive — a human-readable fallback that is simpler to restore than WAL replay.
3. **HNSW index rebuild note:** pgvector HNSW indexes are stored on-disk in Postgres data files and are restored with `pg_basebackup`. They do not need to be rebuilt after a base backup restore. After `pg_dump` + `pg_restore`, the index is rebuilt from the stored vectors (Postgres recreates it on `CREATE INDEX`).

For the markdown vault (if used as system of record per gbrain pattern): `git commit` on every dream cycle + push to a private remote. Git is your vault backup and your audit log simultaneously.

### Docker Compose Layout

A minimal single-VM compose for the memory engine:

```yaml
# docker-compose.yml — second brain VM
version: "3.9"
services:
  db:
    image: pgvector/pgvector:pg17  # pgvector pre-installed
    restart: unless-stopped
    environment:
      POSTGRES_DB: brain
      POSTGRES_USER: brain
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d   # schema.sql runs on first start
    ports:
      - "127.0.0.1:5432:5432"               # localhost only; Tailscale for remote
    shm_size: "256mb"

  agent:
    build: ./agent
    restart: unless-stopped
    depends_on: [db]
    environment:
      DATABASE_URL: postgres://brain:${DB_PASSWORD}@db:5432/brain
      ANTHROPIC_API_KEY_FILE: /run/secrets/anthropic_key
    volumes:
      - ./skills:/app/skills
      - ./inbox:/app/inbox
    secrets: [anthropic_key, db_password]

  wal-archive:
    image: wal-g/wal-g:latest             # or use pgbackup sidecar
    depends_on: [db]
    environment:
      WALG_S3_PREFIX: s3://your-bucket/brain-wal
    volumes:
      - pg_data:/var/lib/postgresql/data:ro

volumes:
  pg_data:

secrets:
  db_password:
    file: ./secrets/db_password.txt
  anthropic_key:
    file: ./secrets/anthropic_key.txt
```

No Redis. No separate vector DB container. One data volume to back up.

---

## 7. Recommended Schema

The following is a concrete schema sketch. It is engineering design, not a verified benchmark claim. Column choices reflect the gbrain teardown, the bitemporal data model (valid_time + system_time), and the pgvector extension's storage model.

### Extension List

```sql
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector: HNSW + halfvec
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- trigram similarity, fuzzy match
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- GIN on scalar types for multi-col indexes
-- Optional, add when ParadeDB BM25 is desired:
-- CREATE EXTENSION IF NOT EXISTS pg_search;
```

### Schema

```sql
-- ============================================================
-- PAGES: episodic + semantic documents (unit of synthesis)
-- ============================================================
CREATE TABLE pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,           -- human-readable stable key
  type            TEXT NOT NULL,                  -- 'note','person','concept','meeting','email','daily'
  title           TEXT NOT NULL,
  compiled_truth  TEXT,                           -- synthesized, rewritten by dream cycle
  timeline        TEXT,                           -- append-only raw evidence
  frontmatter     JSONB NOT NULL DEFAULT '{}',
  content_hash    TEXT,                           -- SHA-256 of source markdown; dedup gate
  emotional_weight REAL NOT NULL DEFAULT 0.5,     -- 0–1 salience; recomputed nightly
  effective_date  TIMESTAMPTZ,                    -- best-known event date (provenance chain)
  last_retrieved_at TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,                   -- soft delete; 72h recovery window
  generation      INTEGER NOT NULL DEFAULT 0,    -- bumped on each synthesis; cache key
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Weighted FTS: A=title, B=compiled_truth, C=timeline
CREATE INDEX pages_fts_idx ON pages
  USING GIN (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(timeline, '')), 'C')
  );
CREATE INDEX pages_type_idx ON pages (type) WHERE deleted_at IS NULL;
CREATE INDEX pages_effective_date_idx ON pages (effective_date DESC) WHERE deleted_at IS NULL;

-- ============================================================
-- CONTENT_CHUNKS: embedded sub-units of pages
-- ============================================================
CREATE TABLE content_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  chunk_text      TEXT NOT NULL,
  -- Full-precision for high-recall queries; use halfvec for lower RAM
  -- text-embedding-3-large = 1536d; zembed-1 = 1280d; set once at init
  embedding       HALFVEC(1536),                 -- halfvec: 2×d+8 bytes ≈ 3.1KB/chunk
  fts_vector      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
  is_compiled_truth BOOLEAN NOT NULL DEFAULT false, -- boost 2× in RRF
  corpus_gen_hash TEXT,                           -- prompt|model|wrapper version; triggers re-embed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index: m=16 (default), ef_construction=64; increase m to 32 for higher recall
-- at cost of ~2× index build time and ~30% more RAM
CREATE INDEX chunks_hnsw_idx ON content_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX chunks_fts_idx ON content_chunks USING GIN (fts_vector);
CREATE INDEX chunks_page_id_idx ON content_chunks (page_id, chunk_index);

-- ============================================================
-- FACTS: atomic claims with bitemporal validity
-- Bitemporal = valid_time (when true in reality) +
--              system_time (when recorded here) [vote 3-0]
-- ============================================================
CREATE TABLE facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID REFERENCES pages(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('event','preference','commitment','belief','fact','habit')),
  claim           TEXT NOT NULL,
  -- valid_time: when this was/is true in reality
  valid_from      DATE,
  valid_until     DATE,                          -- NULL = still believed true
  -- system_time: when we recorded/learned this (bitemporal second axis)
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at   TIMESTAMPTZ,                   -- system-time invalidation; keeps full history
  superseded_by   UUID REFERENCES facts(id),
  confidence      REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','world')),
  notability      REAL NOT NULL DEFAULT 0.5,
  source          TEXT,                          -- 'mcp:put_page' | 'cli:think' | 'fence:reconcile'
  embedding       HALFVEC(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX facts_page_idx ON facts (page_id) WHERE superseded_at IS NULL;
CREATE INDEX facts_kind_idx ON facts (kind) WHERE superseded_at IS NULL;
CREATE INDEX facts_valid_range_idx ON facts (valid_from, valid_until) WHERE superseded_at IS NULL;
-- For bitemporal history queries (what did we know as-of system time T?):
CREATE INDEX facts_system_time_idx ON facts (recorded_at, superseded_at);
CREATE INDEX facts_hnsw_idx ON facts
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- EDGES (TYPED GRAPH): relationship layer
-- Compatible with Graphiti temporal schema if migrating later
-- ============================================================
CREATE TABLE edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_page_id    UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,  -- 'works_at','invested_in','founded','attended','mentions','advises'
  -- Temporal validity on the relationship itself
  valid_from      DATE,
  valid_until     DATE,
  confidence      REAL NOT NULL DEFAULT 1.0,
  link_source     TEXT NOT NULL DEFAULT 'manual',  -- 'markdown'|'wikilink'|'llm_extract'|'manual'
  provenance_page UUID REFERENCES pages(id),        -- which page asserted this edge
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX edges_from_idx ON edges (from_page_id, link_type);
CREATE INDEX edges_to_idx   ON edges (to_page_id,   link_type);
CREATE UNIQUE INDEX edges_dedup_idx ON edges (from_page_id, to_page_id, link_type)
  WHERE valid_until IS NULL;  -- one active edge per (from, to, type)

-- ============================================================
-- EPISODES / EVENT LOG: every agent turn, ingestion event
-- ============================================================
CREATE TABLE episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID,
  source          TEXT NOT NULL,   -- 'telegram'|'cli'|'voice'|'ingestion'|'dream_cycle'
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  token_input     INTEGER,
  token_output    INTEGER,
  cost_usd        NUMERIC(10,6),
  page_refs       UUID[],          -- pages touched by this turn
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX episodes_session_idx ON episodes (session_id, created_at DESC);
CREATE INDEX episodes_source_idx  ON episodes (source, created_at DESC);

-- ============================================================
-- FRICTION LOG: structured confusion/blocker events
-- Substrate for nightly skill-creation clustering
-- (gbrain pattern: src/core/friction.ts)
-- ============================================================
CREATE TABLE friction_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      UUID REFERENCES episodes(id),
  friction_type   TEXT NOT NULL,  -- 'confusion'|'blocker'|'repeated_task'|'slow_path'|'failure'
  description     TEXT NOT NULL,
  context         JSONB NOT NULL DEFAULT '{}',
  cluster_id      UUID,           -- assigned by nightly clustering phase
  skill_drafted   UUID,           -- set when a skill is drafted from this cluster
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX friction_unresolved_idx ON friction_events (friction_type, created_at)
  WHERE resolved_at IS NULL;
CREATE INDEX friction_cluster_idx ON friction_events (cluster_id) WHERE cluster_id IS NOT NULL;

-- ============================================================
-- JOB QUEUE: Postgres-native, no Redis
-- (gbrain minion_jobs pattern; pg-boss compatible shape)
-- ============================================================
CREATE TABLE minion_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,           -- job type: 'dream_cycle'|'embed_page'|'extract_facts'
  payload         JSONB NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'created'
                  CHECK (state IN ('created','active','completed','failed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 100,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  retry_delay_s   INTEGER NOT NULL DEFAULT 60,  -- base delay; exponential backoff applied
  lease_at        TIMESTAMPTZ,                  -- set by worker claiming the job
  lease_ttl_s     INTEGER NOT NULL DEFAULT 300, -- stall detection threshold
  idempotency_key TEXT UNIQUE,                  -- slot-keyed; prevents double-enqueue
  parent_id       UUID REFERENCES minion_jobs(id),
  token_budget    INTEGER,                      -- max tokens this job may spend
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_pending_idx ON minion_jobs (priority DESC, run_after ASC)
  WHERE state = 'created';
CREATE INDEX jobs_stall_idx ON minion_jobs (lease_at)
  WHERE state = 'active';  -- worker supervisor polls this to detect stalled jobs
CREATE INDEX jobs_parent_idx ON minion_jobs (parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- SPEND LOG: model calls, token accounting, budget gate
-- ============================================================
CREATE TABLE spend_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model           TEXT NOT NULL,
  purpose         TEXT,           -- 'synthesis'|'extraction'|'embedding'|'query_expansion'
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  job_id          UUID REFERENCES minion_jobs(id),
  episode_id      UUID REFERENCES episodes(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX spend_daily_idx ON spend_log (date_trunc('day', created_at), model);
```

### Index Choices Summary

| Table | Index | Type | Rationale |
|---|---|---|---|
| `content_chunks.embedding` | `chunks_hnsw_idx` | HNSW cosine, m=16, ef=64 | Streaming-compatible (no bulk retraining) [3-0]; increase m→32 for >100k chunks if recall is unsatisfactory |
| `content_chunks.fts_vector` | `chunks_fts_idx` | GIN | Standard for tsvector; needed for the FTS arm of RRF |
| `pages` FTS | `pages_fts_idx` | GIN (multi-column weighted) | A/B/C weights on title/compiled_truth/timeline |
| `facts.embedding` | `facts_hnsw_idx` | HNSW cosine | Semantic recall of hot-memory facts |
| `facts` temporal | `facts_valid_range_idx`, `facts_system_time_idx` | B-tree | Bitemporal queries ("what was true in Jan?" / "what did we know last week?") [3-0] |
| `edges` | `edges_from_idx`, `edges_to_idx` | B-tree | Graph traversal in both directions |
| `minion_jobs` pending | `jobs_pending_idx` | B-tree partial | Fast worker poll; partial index only on `created` state |

---

## Refuted Claims (Transparency)

| Claim | Vote | Why it matters |
|---|---|---|
| pgvector supports only 768, 1024, or 1536 dimensions | 1-2 | Incorrect — pgvector supports arbitrary dimensions up to 16,000; do not hard-code dimension choices based on this |
| LanceDB-Go: 6ms p50 at 100k vectors, 283× faster than sqlite-vec | 1-2 | Unverified vendor benchmark; do not use as a basis for embedded-DB selection |
| Embedded vector DBs become impractical above 10M vectors | 0-3 | False ceiling; do not let this drive premature architectural migration |
| FalkorDB: 496× faster P99 than traditional options | 0-3 | Marketing claim, not independently replicated; do not use as a graph-DB selection criterion |
| Graphiti + FalkorDB: sub-millisecond responses for live agents | 0-3 | Refuted; do not build latency SLAs on this |
| pg_search (ParadeDB): atomic backup with data, no separate replication strategy | 1-2 | Uncertain; verify current ParadeDB docs before relying on backup atomicity |

---

## Caveats

- **HNSW parameter guidance** (m=16, ef=64) is from pgvector's defaults with no single verified benchmark for the memory-corpus shape (mixed chunk lengths, continuous inserts). Tune with `pgvector_ef_search` at query time and measure recall vs latency on your actual corpus.
- **halfvec vs vector:** half-precision (`halfvec`) halves RAM at a potential precision cost. For most semantic retrieval tasks at this scale, the quality difference is negligible. Verify with a recall test on your chosen embedding model before committing.
- **Schema is a sketch, not a migration file.** Column types, constraints, and index names should be reconciled with your migration tooling. Treat this as a design specification, not runnable DDL without review.
- **Bitemporal facts model** is correct in theory [3-0] but adds query complexity. The `valid_from`/`valid_until` + `recorded_at`/`superseded_at` pattern covers the full bitemporal model; simpler systems omit `recorded_at`/`superseded_at` and pay with inability to answer "what did we think was true as of last Tuesday?"
- **ParadeDB BM25:** the backup-atomicity claim was refuted 1-2. Treat ParadeDB as a quality upgrade over tsvector with the same operational care as any Postgres extension.
- **Graphiti integration path:** as of 2026-06-10, Graphiti does not support Postgres as a graph backend. Adding it means adding Neo4j or FalkorDB as a second database. The performance claims for FalkorDB were refuted 0-3; Neo4j adds licensing cost at scale. The typed-edge SQL table approach is the pragmatic default with a clear migration path.

---

## Open Questions

1. **zembed-1 (ZeroEntropy) vs text-embedding-3-large:** gbrain is migrating to zembed-1 (1280-d Matryoshka, claimed 2.6× cheaper). No adversarially verified recall comparison at this use-case shape exists. Which model is the right default for a personal second brain with mixed note/email/conversation content?
2. **ParadeDB production maturity in 2026:** the pg_search extension has been evolving rapidly. Is it stable enough for a 24/7 single-VM deployment, or should it be deferred to a v2 migration when tsvector proves insufficient?
3. **ef_search tuning:** what is the right `pgvector.ef_search` setting for a second-brain query (recall@10 > 0.95 requirement, p99 < 200ms target) at 100k, 500k, and 1M chunk scales? No published benchmark covers this exact corpus shape.
4. **HNSW index build during continuous inserts:** does inserting at high volume (ingestion daemon burst) degrade HNSW index quality over time compared to a bulk-build-then-insert pattern? When is a full index rebuild worth scheduling?
5. **Graphiti's Postgres backend:** is a Postgres-native Graphiti backend planned? If so, the single-database constraint could be maintained while gaining Graphiti's temporal knowledge graph semantics. Worth watching the getzep/graphiti roadmap.
