-- ============================================================
-- Working-memory scratchpad: a single ephemeral row Somnus can freely
-- overwrite mid-session, without the bitemporal overhead of the facts table.
-- Cleared nightly by the dream cycle's decay phase.
-- ============================================================
CREATE TABLE IF NOT EXISTS scratch_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
