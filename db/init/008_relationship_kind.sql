-- ============================================================
-- Extend the facts kind enum with 'relationship' (people memory) and 'scratch'.
-- The inline check on facts.kind is auto-named facts_kind_check; drop + re-add
-- with the widened set. Additive — existing rows all satisfy the new constraint.
-- ============================================================
ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_kind_check;
ALTER TABLE facts ADD CONSTRAINT facts_kind_check
  CHECK (kind IN ('event','preference','commitment','belief','fact','habit','persona','relationship','scratch'));
