#!/usr/bin/env bash
# Somnus → Claude Code session driver (container variant; Mac original lives
# in tools/cc.sh and is NOT shipped in the image).
#   cc.sh clone <owner/repo>
#   cc.sh run <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh resume <session-id> <project-dir> "<prompt>" [extra claude flags...]
#   cc.sh list
#   cc.sh push <project-dir> <branch>
#
# run/resume execute headless (claude -p, JSON out) billed to Tyler's
# subscription: ANTHROPIC_API_KEY is explicitly dropped so the CLI cannot
# fall back to API billing, leaving CLAUDE_CODE_OAUTH_TOKEN as the only auth.
# GITHUB_TOKEN is visible only to clone/push (pure git, no model involved);
# headless sessions never see it. Sessions run with acceptEdits; their own
# Bash stays disabled unless extra flags grant it.
set -euo pipefail

REPOS_DIR="${REPOS_DIR:-/app/workspace/repos}"
SPOOL="${CC_SPEND_SPOOL:-/app/workspace/.cc-spend.jsonl}"
ASKPASS="$(cd "$(dirname "$0")" && pwd)/git-askpass.sh"
DEFAULT_MODEL="claude-sonnet-4-6"

run_claude() { # <dir> <prompt> [extra flags...]
  local dir=$1 prompt=$2
  shift 2
  local model_args=()
  case " $* " in
    *" --model "*) ;;
    *) model_args=(--model "$DEFAULT_MODEL") ;;
  esac
  cd "$dir"
  local out
  out=$(env -u ANTHROPIC_API_KEY -u GITHUB_TOKEN \
    claude -p "$prompt" --output-format json --permission-mode acceptEdits \
    "${model_args[@]}" "$@") || {
    local code=$?
    echo "[cc.sh] claude exited $code — session failed (check token expiry / rate limits / flags)" >&2
    exit "$code"
  }
  printf '%s\n' "$out"
  # Spend spool — cc.sh has no DB access (DATABASE_URL is scrubbed from this
  # env on purpose); the scheduler sweeps this file into spend_log.
  node -e '
    let parsed = {};
    try { parsed = JSON.parse(process.argv[1]); } catch {}
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
      session_id: parsed.session_id ?? null,
      dir: process.argv[2],
    });
    require("node:fs").appendFileSync(process.argv[3], line + "\n");
  ' "$out" "$dir" "$SPOOL" || true
}

cmd=${1:?usage: cc.sh clone|run|resume|list|push}
case "$cmd" in
  clone)
    spec=${2:?owner/repo}
    name=${spec##*/}
    mkdir -p "$REPOS_DIR"
    GIT_ASKPASS="$ASKPASS" git clone "https://x-access-token@github.com/$spec.git" "$REPOS_DIR/$name"
    echo "cloned to $REPOS_DIR/$name"
    ;;
  run)
    dir=${2:?project dir}
    prompt=${3:?prompt}
    shift 3
    run_claude "$dir" "$prompt" "$@"
    ;;
  resume)
    sid=${2:?session id}
    dir=${3:?project dir}
    prompt=${4:?prompt}
    shift 4
    run_claude "$dir" "$prompt" --resume "$sid" "$@"
    ;;
  list)
    for d in $(ls -t "$HOME/.claude/projects" 2>/dev/null | head -10); do
      latest=$(ls -t "$HOME/.claude/projects/$d" 2>/dev/null | head -1)
      echo "$d  latest: ${latest%.jsonl}"
    done
    ;;
  push)
    dir=${2:?project dir}
    branch=${3:?branch}
    case "$branch" in
      main|master)
        echo "refusing to push to $branch — use a feature branch" >&2
        exit 1
        ;;
    esac
    cd "$dir"
    GIT_ASKPASS="$ASKPASS" git push origin "HEAD:$branch"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
