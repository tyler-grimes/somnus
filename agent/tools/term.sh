#!/usr/bin/env bash
# Container-side term bridge: forward term.sh args to the Mac over Tailscale.
# The Mac authorized_keys entry forces term-bridge.sh, which allow-lists the
# request and runs the real term.sh there. Filename matches HOST_TOOL_RE, so
# every invocation is Telegram-gated by the harness (never automode).
set -euo pipefail

MAC_SSH_HOST="${MAC_SSH_HOST:?MAC_SSH_HOST not set}"
MAC_SSH_USER="${MAC_SSH_USER:?MAC_SSH_USER not set}"
KEY="${TERM_BRIDGE_KEY:-/home/node/.ssh/term-bridge}"

if [ ! -r "$KEY" ]; then
  echo "term.sh: bridge key not readable at $KEY" >&2
  exit 1
fi

exec ssh -i "$KEY" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=10 \
  "$MAC_SSH_USER@$MAC_SSH_HOST" "$@"
