-- ============================================================
-- Visibility guardrail views (security research #4)
--
-- facts.visibility is enforced in brain-mcp via visibilityClause(),
-- but any OUTWARD-FACING tool (share, export, public API, a second
-- agent) must read from these views, never from facts directly —
-- then a forgotten WHERE clause cannot leak private rows.
--
-- Existing databases: this file only auto-runs on first container
-- start. Apply manually with:
--   docker compose exec -T db psql -U brain -d brain \
--     -f /docker-entrypoint-initdb.d/002_visibility.sql
-- ============================================================

-- CREATE OR REPLACE so re-applying this file (e.g. migrate.sh recovering from a
-- partially-tracked baseline) is idempotent and never errors on "already exists".
CREATE OR REPLACE VIEW facts_world AS
  SELECT id, kind, claim, valid_from, valid_until, confidence
  FROM facts
  WHERE visibility = 'world' AND superseded_at IS NULL;

CREATE OR REPLACE VIEW facts_shared AS
  SELECT id, kind, claim, valid_from, valid_until, confidence
  FROM facts
  WHERE visibility IN ('shared', 'world') AND superseded_at IS NULL;
