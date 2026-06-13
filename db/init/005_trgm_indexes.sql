-- ============================================================
-- Trigram indexes for the similarity() dedup/cluster scans
-- (audit fixes: dream extractFacts + clusterFriction did full
-- sequential scans with no operator-class acceleration).
--
-- pg_trgm is created in 001_schema.sql. These partial GIN indexes
-- accelerate the `similarity(col, $1) > t` predicates against the
-- active (non-superseded / unresolved) rows the dream cycle scans.
--
-- IF NOT EXISTS keeps this file replay-safe.
-- ============================================================

CREATE INDEX IF NOT EXISTS facts_claim_trgm_idx
  ON facts USING GIN (claim gin_trgm_ops)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS friction_desc_trgm_idx
  ON friction_events USING GIN (description gin_trgm_ops)
  WHERE resolved_at IS NULL;
