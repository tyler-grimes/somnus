#!/usr/bin/env bash
# Somnus → live terminal control via tmux.
#   term.sh list                  — sessions/windows/panes with running commands
#   term.sh peek <pane> [lines]   — read the last N lines of a pane (default 60)
#   term.sh send <pane> "<text>"  — type text into a pane and press Enter
#   term.sh keys <pane> <keys>    — send raw keys (e.g. Escape, C-c) no Enter
#
# <pane> is a tmux target like "main:0.1" or "%3" (see list output).
# Only panes inside tmux are controllable — plain terminal windows are not.
set -euo pipefail

cmd=${1:?usage: term.sh list|peek|send|keys}
case "$cmd" in
  list)
    tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}  [#{pane_id}]  #{pane_current_command}  #{pane_current_path}  #{?pane_active,(active),}' 2>/dev/null \
      || echo "no tmux server running"
    ;;
  peek)
    pane=${2:?pane target}
    lines=${3:-60}
    tmux capture-pane -p -t "$pane" -S "-$lines"
    ;;
  send)
    pane=${2:?pane target}
    text=${3:?text to send}
    # -l = literal (no key-name interpretation), then Enter separately
    tmux send-keys -t "$pane" -l "$text"
    tmux send-keys -t "$pane" Enter
    ;;
  keys)
    pane=${2:?pane target}
    shift 2
    tmux send-keys -t "$pane" "$@"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
