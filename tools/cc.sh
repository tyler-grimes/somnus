#!/usr/bin/env bash
# Somnus → Claude Code session driver.
#   cc.sh run <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh resume <session-id> <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh list
#
# run/resume execute headless (claude -p) with --output-format json: stdout is
# a JSON object containing session_id, result, total_cost_usd. Sessions run
# with acceptEdits (file edits allowed in the target project; their own Bash
# stays disabled unless extra flags grant it).
set -euo pipefail

cmd=${1:?usage: cc.sh run|resume|list}
case "$cmd" in
  run)
    dir=${2:?project dir}
    prompt=${3:?prompt}
    shift 3
    cd "$dir"
    exec claude -p "$prompt" --output-format json --permission-mode acceptEdits "$@"
    ;;
  resume)
    sid=${2:?session id}
    dir=${3:?project dir}
    prompt=${4:?prompt}
    shift 4
    cd "$dir"
    exec claude -p "$prompt" --resume "$sid" --output-format json --permission-mode acceptEdits "$@"
    ;;
  list)
    # Most recently active Claude Code projects and their latest sessions
    for d in $(ls -t "$HOME/.claude/projects" 2>/dev/null | head -10); do
      latest=$(ls -t "$HOME/.claude/projects/$d" 2>/dev/null | head -1)
      echo "$d  latest: ${latest%.jsonl}"
    done
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
