-- CC session transcripts ingested from ~/.claude/projects/**/*.jsonl
CREATE TABLE IF NOT EXISTS cc_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT        UNIQUE NOT NULL,  -- JSONL filename stem (UUID)
  title          TEXT,                          -- from ai-title type line
  task_prompt    TEXT,                          -- first user message
  result_summary TEXT,                          -- last assistant text, capped at 2000 chars
  jsonl_path     TEXT        NOT NULL,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_sessions_ingested_at_idx ON cc_sessions (ingested_at DESC);
