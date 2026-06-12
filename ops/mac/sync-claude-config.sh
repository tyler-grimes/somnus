#!/usr/bin/env bash
# Mirror the Mac's Claude Code CONFIG (skills, plugins, hooks, settings) into
# the somnus-vm agent container's claude_state volume, so headless cc.sh
# sessions get the same skills/plugins as Tyler's interactive Claude Code.
#
# Config only — NEVER credentials, history.jsonl, projects/ (session
# transcripts), or caches. Mac-absolute paths in settings are rewritten for
# the container home. Re-run after changing skills/plugins on the Mac.
set -euo pipefail

VM_HOST="${VM_HOST:-somnus-vm}"
SRC="$HOME/.claude"
STAGE="claude-config-sync"

ITEMS=(skills plugins hooks agents CLAUDE.md settings.json settings.local.json keybindings.json)

args=()
for i in "${ITEMS[@]}"; do
  [ -e "$SRC/$i" ] && args+=("$SRC/$i")
done
[ "${#args[@]}" -gt 0 ] || { echo "nothing to sync from $SRC" >&2; exit 1; }

# Per-item copy into a flat staging dir (macOS openrsync mishandles
# --relative's /./ anchor, so no fancy path surgery here).
# --copy-unsafe-links: symlinks escaping the tree (e.g. skills/find-skills →
# ~/.agents/...) become real files; docker cp refuses escaping symlinks.
ssh "$VM_HOST" "mkdir -p $STAGE"
rsync -a --delete --copy-unsafe-links "${args[@]}" "$VM_HOST:$STAGE/"

ssh "$VM_HOST" '
  set -euo pipefail
  STAGE="claude-config-sync"
  for f in settings.json settings.local.json; do
    [ -f "$STAGE/$f" ] && sed -i "s|/Users/tylergrimes|/home/node|g" "$STAGE/$f"
  done
  cd ~/somnus
  docker compose cp ~/"$STAGE"/. agent:/home/node/.claude/
  docker compose exec -T -u root agent chown -R node:node /home/node/.claude
  echo "--- container ~/.claude now: ---"
  docker compose exec -T agent sh -c "ls /home/node/.claude; du -sh /home/node/.claude/plugins 2>/dev/null || true"
'
