#!/usr/bin/env bash
# Apply db/init/*.sql migrations once each, tracked in schema_migrations.
# Runs as a one-shot compose service (see docker-compose.yml `migrate`) before
# agent/dashboard start, so new schema files no longer need a manual psql.
#
# Why a tracker and not blind re-run: 001/002 use bare CREATE TABLE/VIEW (not
# idempotent), so replaying them errors. The first time this runs against a DB
# that already has the schema, it adopts the current files as a baseline (marks
# them applied without running them); thereafter only newly added files apply.
#
#   Fresh DB:    docker-entrypoint-initdb.d already ran every *.sql at init →
#                facts exists → baseline-adopt → nothing re-runs.
#   Existing DB: facts exists → baseline-adopt current files, then apply 004+.
set -euo pipefail

q() { psql -v ON_ERROR_STOP=1 -qtA "$@"; }

q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now());"

tracked=$(q -c "SELECT count(*) FROM schema_migrations;" | tr -d '[:space:]')
has_schema=$(q -c "SELECT (to_regclass('public.facts') IS NOT NULL);" | tr -d '[:space:]')

if [ "$tracked" = "0" ] && [ "$has_schema" = "t" ]; then
  echo "[migrate] existing schema detected — adopting current files as baseline"
  for f in /migrations/*.sql; do
    q -c "INSERT INTO schema_migrations (filename) VALUES ('$(basename "$f")')
          ON CONFLICT DO NOTHING;"
  done
fi

for f in /migrations/*.sql; do
  name=$(basename "$f")
  if [ "$(q -c "SELECT 1 FROM schema_migrations WHERE filename='$name';" | tr -d '[:space:]')" = "1" ]; then
    echo "[migrate] skip $name (already applied)"
    continue
  fi
  echo "[migrate] applying $name"
  q -f "$f"
  q -c "INSERT INTO schema_migrations (filename) VALUES ('$name');"
done

echo "[migrate] done"
