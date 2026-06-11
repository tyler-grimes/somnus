#!/usr/bin/env bash
# Nightly Somnus DB dump on the VM. Keep 7 days locally; the Mac pulls and
# keeps 30 (two machines, two retention windows — design spec §4).
# Cron (runs after the 04:00 dream cycle):
#   30 4 * * * /home/somnus/somnus/ops/vm/backup.sh >> /var/log/somnus-backup.log 2>&1
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/somnus}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/somnus}"

mkdir -p "$BACKUP_DIR"
stamp=$(date +%F)
docker compose --project-directory "$REPO_DIR" exec -T db \
  pg_dump -Fc -U brain brain > "$BACKUP_DIR/brain-$stamp.dump"

# Prune to the 7 newest dumps.
ls -1t "$BACKUP_DIR"/brain-*.dump | tail -n +8 | while read -r f; do
  rm -f "$f"
done

echo "$(date -Is) wrote $BACKUP_DIR/brain-$stamp.dump ($(du -h "$BACKUP_DIR/brain-$stamp.dump" | cut -f1))"
