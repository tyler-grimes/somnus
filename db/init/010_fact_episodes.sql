-- Adds episode provenance to facts: episode ids a fact was distilled from.
-- dream:extract phase only (not persona). UUID[] like episodes.page_refs; no FK (episodes append-only).
ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_episode_ids UUID[];

COMMENT ON COLUMN facts.source_episode_ids IS
  'Episodes this fact was distilled from (dream:extract phase only). No FK by design.';
