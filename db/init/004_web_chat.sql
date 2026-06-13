-- Web console ↔ Somnus chat handoff. The dashboard inserts a pending row;
-- the agent poller (webchat.ts) claims it, runs a turn, writes the reply.
CREATE TABLE IF NOT EXISTS web_chat (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt      TEXT NOT NULL,
  reply       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS web_chat_pending_idx ON web_chat (created_at) WHERE status = 'pending';
