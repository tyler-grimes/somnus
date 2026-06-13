#!/usr/bin/env bash
# SSH forced-command for the Somnus term bridge. The authorized_keys entry
# pins command="…/term-bridge.sh", so SSH ignores the client's requested
# command and runs this instead, passing the original request in
# $SSH_ORIGINAL_COMMAND. We allow ONLY term.sh subcommands — never an
# arbitrary shell command — then exec the real term.sh.
#
# (send/keys still drive a pane, which is the accepted risk; this guard
# stops the key from being a general shell, not from using term.sh.)
set -euo pipefail

# Forced commands inherit a minimal PATH; common tool dirs (incl. Homebrew on macOS).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

HERE="$(cd "$(dirname "$0")" && pwd)"
req="${SSH_ORIGINAL_COMMAND:-}"

# First whitespace-delimited token must be an allowed subcommand.
sub="${req%%[[:space:]]*}"
case "$sub" in
  list|peek|send|keys) ;;
  *)
    echo "term-bridge: refused ('$sub' not in list|peek|send|keys)" >&2
    exit 1
    ;;
esac

# Re-split the original request into args and run the real term.sh. Word
# splitting is intentional (term.sh's own quoting handles the text arg); but
# disable globbing first so a request like `peek *` can't expand to the home
# directory's filenames before reaching term.sh.
set -f
# shellcheck disable=SC2086
exec "$HERE/term.sh" $req
