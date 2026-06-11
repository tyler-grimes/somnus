-- ============================================================
-- Second Brain — memory engine schema (v1)
-- Design spec: research/database-selection.md §7
-- Runs automatically on first container start via
-- /docker-entrypoint-initdb.d
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector: HNSW + halfvec
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- trigram similarity, fuzzy match
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- GIN on scalar types for multi-col indexes

-- ============================================================
-- PAGES: episodic + semantic documents (unit of synthesis)
-- ============================================================
CREATE TABLE pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        TEXT NOT NULL DEFAULT 'tyler',
  slug            TEXT UNIQUE NOT NULL,           -- human-readable stable key
  type            TEXT NOT NULL,                  -- 'note','person','concept','meeting','email','daily'
  title           TEXT NOT NULL,
  compiled_truth  TEXT,                           -- synthesized, rewritten by dream cycle
  timeline        TEXT,                           -- append-only raw evidence
  frontmatter     JSONB NOT NULL DEFAULT '{}',
  content_hash    TEXT,                           -- SHA-256 of source markdown; dedup gate
  emotional_weight REAL NOT NULL DEFAULT 0.5,     -- 0-1 salience; recomputed nightly
  effective_date  TIMESTAMPTZ,                    -- best-known event date (provenance chain)
  last_retrieved_at TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,                    -- soft delete; recovery window before purge
  generation      INTEGER NOT NULL DEFAULT 0,     -- bumped on each synthesis; cache key
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Weighted FTS: A=title, B=compiled_truth, C=timeline
CREATE INDEX pages_fts_idx ON pages
  USING GIN ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(timeline, '')), 'C')
  ));
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
  -- Dimension fixed at init; 1536 = text-embedding-3-large.
  -- halfvec: 2*d+8 bytes ~= 3.1KB/chunk at 1536d.
  embedding       HALFVEC(1536),
  fts_vector      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
  is_compiled_truth BOOLEAN NOT NULL DEFAULT false, -- boost 2x in RRF
  corpus_gen_hash TEXT,                             -- prompt|model|wrapper version; triggers re-embed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, chunk_index)
);

-- HNSW: m=16, ef_construction=64 (pgvector defaults; raise m to 32 past ~100k
-- chunks if recall is unsatisfactory — costs ~2x build time, ~30% more RAM)
CREATE INDEX chunks_hnsw_idx ON content_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX chunks_fts_idx ON content_chunks USING GIN (fts_vector);
CREATE INDEX chunks_page_id_idx ON content_chunks (page_id, chunk_index);

-- ============================================================
-- FACTS: atomic claims with bitemporal validity
-- valid_time  = when true in reality (valid_from / valid_until)
-- system_time = when recorded here   (recorded_at / superseded_at)
-- Contradiction resolution: close the old row, never delete.
-- ============================================================
CREATE TABLE facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        TEXT NOT NULL DEFAULT 'tyler',
  page_id         UUID REFERENCES pages(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('event','preference','commitment','belief','fact','habit','persona')),
  claim           TEXT NOT NULL,
  valid_from      DATE,
  valid_until     DATE,                          -- NULL = still believed true
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at   TIMESTAMPTZ,                   -- system-time invalidation; keeps full history
  superseded_by   UUID REFERENCES facts(id),
  confidence      REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','world')),
  notability      REAL NOT NULL DEFAULT 0.5,
  source          TEXT,                          -- 'mcp:put_page' | 'cli:think' | 'dream:extract'
  embedding       HALFVEC(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX facts_page_idx ON facts (page_id) WHERE superseded_at IS NULL;
CREATE INDEX facts_kind_idx ON facts (kind) WHERE superseded_at IS NULL;
CREATE INDEX facts_valid_range_idx ON facts (valid_from, valid_until) WHERE superseded_at IS NULL;
-- Bitemporal history queries ("what did we know as-of system time T?")
CREATE INDEX facts_system_time_idx ON facts (recorded_at, superseded_at);
CREATE INDEX facts_hnsw_idx ON facts
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- EDGES (TYPED GRAPH): relationship layer
-- Temporal validity + provenance kept Graphiti-compatible for a
-- possible future export (research/graph-db-vs-relational-verdict.md)
-- ============================================================
CREATE TABLE edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_page_id    UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,  -- 'works_at','invested_in','founded','attended','mentions','advises'
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
-- EPISODES / EVENT LOG: every agent turn, ingestion event.
-- Append-only; never rewritten. Fast path: no LLM calls on write.
-- ============================================================
CREATE TABLE episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        TEXT NOT NULL DEFAULT 'tyler',
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
-- FRICTION LOG: structured confusion/blocker/repetition events.
-- Substrate for the nightly skill-creation clustering (built last).
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
-- SPEND LOG: model calls, token accounting, budget gate.
-- Job queue itself is owned by pg-boss (auto-creates its own
-- `pgboss` schema on first worker start) — job_id refers to
-- pgboss.job.id without a cross-schema FK.
-- ============================================================
CREATE TABLE spend_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model           TEXT NOT NULL,
  purpose         TEXT,           -- 'synthesis'|'extraction'|'embedding'|'query_expansion'
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  job_id          UUID,
  episode_id      UUID REFERENCES episodes(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- date_trunc('day', timestamptz) is STABLE (TZ-dependent), not allowed in an
-- index — plain (created_at, model) covers the daily budget-gate scan.
CREATE INDEX spend_time_idx ON spend_log (created_at, model);
