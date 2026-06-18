-- ============================================================
-- Per-project context blocks: project-scoped memory that surfaces
-- automatically in core blocks when settings.current_project is set.
-- ============================================================
CREATE TABLE IF NOT EXISTS project_contexts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_slug  TEXT UNIQUE NOT NULL,
  content       TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
