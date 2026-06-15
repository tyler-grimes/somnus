-- ============================================================
-- User-defined crons: recurring tasks the owner schedules in
-- natural language. A one-minute ticker (scheduler.ts) runs each
-- due cron's prompt as a turn and reports to Telegram.
-- ============================================================
CREATE TABLE user_crons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT UNIQUE NOT NULL,        -- human handle, e.g. 'morning-inbox'
  cron_expr    TEXT NOT NULL,               -- standard 5-field cron expression
  prompt       TEXT NOT NULL,               -- task to run as a turn when it fires
  tz           TEXT NOT NULL,               -- IANA tz (defaults to config.timezone at insert)
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ,                 -- last scheduled slot we executed (dedup)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_crons_enabled_idx ON user_crons (enabled) WHERE enabled;
