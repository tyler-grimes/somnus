#!/usr/bin/env bash
# Pull the newest Somnus DB dump from the VM over Tailscale. Runs daily via
# launchd (com.tyler.somnus-backup-pull); launchd fires missed runs on wake.
# Exits 0 silently if the VM is unreachable (Mac offline, VM down) — the next
# run catches up.
set -euo pipefail

VM_HOST="${VM_HOST:-somnus-vm}"
REMOTE_DIR="/var/backups/somnus"
LOCAL_DIR="$HOME/Backups/somnus"

mkdir -p "$LOCAL_DIR"

latest=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VM_HOST" \
  "ls -1t $REMOTE_DIR/brain-*.dump 2>/dev/null | head -1") || exit 0
[ -n "$latest" ] || exit 0

base=$(basename "$latest")
if [ ! -f "$LOCAL_DIR/$base" ]; then
  scp -q -o ConnectTimeout=10 -o BatchMode=yes "$VM_HOST:$latest" "$LOCAL_DIR/$base.partial"
  mv "$LOCAL_DIR/$base.partial" "$LOCAL_DIR/$base"
fi

# Prune to the 30 newest dumps.
ls -1t "$LOCAL_DIR"/brain-*.dump 2>/dev/null | tail -n +31 | while read -r f; do
  rm -f "$f"
done
