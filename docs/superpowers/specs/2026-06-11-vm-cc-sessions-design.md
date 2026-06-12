# VM-Local Claude Code Sessions for Somnus — Design

**Date:** 2026-06-11
**Status:** Approved by Tyler (brainstorming session "somnus")
**Goal:** Give Somnus the ability to run headless Claude Code sessions inside its own container — clone repos, code autonomously, push branches — without weakening the container-as-boundary security model. Sessions bill Tyler's Claude subscription, not the API.

## Context

The Mac-era host tools (`tools/cc.sh`, `tools/term.sh`, `tmux`) cannot work from
the VM: they are excluded from the image and they target Tyler's Mac. Option C
was chosen over an SSH-back bridge (which would put Mac credentials inside the
container) and over removing the capability entirely. The agent's system prompt
still advertises the Mac tools with hardcoded paths — that gets fixed here too.

## Decisions made

| Decision | Choice | Rationale |
|---|---|---|
| Git access | Fine-grained GitHub PAT: Tyler's repos, Contents read/write + Metadata read, 90-day expiry; branch protection on `main` | Somnus can clone, code, push a branch, link a compare URL — merging stays Tyler's |
| Session billing | Tyler's Claude subscription via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (critical feature) | Coding sessions don't consume API budget; agent harness (chat/dream) stays API-billed |
| Spend tracking | Spool file + 10-min sweep into `spend_log`, shared cap | Subscription sessions report ~$0, so this is observability (sessions/day, repos) more than budget; per-invocation human gate is the real control |
| Approval model | `cc.sh` keeps matching `HOST_TOOL_RE` — one Telegram approval per invocation, no standing rules, survives automode | Unchanged security spine from the Mac design |
| Default model | `claude-sonnet-4-6` unless caller passes `--model` | Tyler's background-agent cost/limits preference |

## 1. Image and layout changes

- **Dockerfile (runtime stage, before `USER node`):** `npm install -g @anthropic-ai/claude-code` — the `claude` CLI the wrapper invokes.
- **New repo dir `agent/tools/`** copied into the image at `/app/agent/tools/` with a `COPY` in the runtime stage. The Mac-only `tools/` dir stays excluded by `.dockerignore`.
- **New named volume `claude_state:/home/node/.claude`** so headless session state survives container restarts (`cc.sh resume` works across deploys). Dockerfile pre-creates `/home/node/.claude` owned by `node` so the volume inherits correct ownership.
- Clones live under `/app/workspace/repos/<name>` on the existing `agent_workspace` volume.

## 2. `agent/tools/cc.sh` (container variant)

Subcommands (filename matches the existing `HOST_TOOL_RE`, so every invocation
requires one Telegram approval — never a standing rule, even in automode):

- `cc.sh clone <owner/repo>` — clone `https://github.com/<owner>/<repo>` into `/app/workspace/repos/<repo>` using a `GIT_ASKPASS` helper that echoes `GITHUB_TOKEN`. The token never appears in `.git/config`, remotes, or process args.
- `cc.sh run <dir> "<prompt>" [extra claude flags...]` — `claude -p "<prompt>" --output-format json --permission-mode acceptEdits`, adding `--model claude-sonnet-4-6` only when the caller didn't pass `--model`. Stdout is the JSON object (`session_id`, `result`, `total_cost_usd`).
- `cc.sh resume <session-id> <dir> "<prompt>" [extra claude flags...]` — same, with `--resume`.
- `cc.sh list` — most recent projects/sessions from `~/.claude/projects` (same as Mac version).
- `cc.sh push <dir> <branch>` — `git push origin HEAD:<branch>` via the askpass helper; refuses `main`/`master` as the target branch (belt — branch protection is the suspenders).

Env hygiene inside the wrapper:

- `run`/`resume` exec with `env -u ANTHROPIC_API_KEY -u GITHUB_TOKEN ... claude ...`: with no API key present and `CLAUDE_CODE_OAUTH_TOKEN` set, the CLI cannot silently fall back to API billing, and **headless sessions never see the GitHub PAT**.
- `clone`/`push` are pure git operations — no model involved — and are the only places `GITHUB_TOKEN` is read.
- Sessions' own Bash stays disabled (not granted by `acceptEdits`; unchanged from the Mac design).
- After `run`/`resume`, the wrapper appends a JSONL line `{ts, usd, session_id, dir}` to `/app/workspace/.cc-spend.jsonl` (parsed from the CLI's JSON output; `usd` will be ~0 on subscription).

`agent/tools/git-askpass.sh`: two-liner that prints `$GITHUB_TOKEN` (git calls
it for both username and password prompts; username is sent as
`x-access-token` via the clone URL form `https://x-access-token@github.com/...`).

## 3. Credentials

Two new VM-only `.env` entries (never on the Mac, never in git):

- `GITHUB_TOKEN` — fine-grained PAT as decided above. **Not** added to `SECRET_ENV_VARS` in `sandbox.ts` (cc.sh needs it via the subprocess env); the existing `env -i` wrapper (layer 2) already hides it from every sandboxed Bash command, and §2 keeps it away from headless sessions.
  Amended 2026-06-11: org-owned repos (neurotime) get `GITHUB_TOKEN_<OWNER>`
  vars; cc.sh selects by repo owner, falls back to `GITHUB_TOKEN`. Sessions
  see none of the `GITHUB_TOKEN*` vars.
- `CLAUDE_CODE_OAUTH_TOKEN` — minted once on Tyler's Mac with `claude setup-token` (browser OAuth, ~1-year expiry, revocable at claude.ai settings). Same env-layering treatment as the PAT.

Accepted trade (documented, approved): both tokens are Tyler-account
credentials living in the container, same exposure class as the existing
`ANTHROPIC_API_KEY` (e.g. a session's Read tool could read
`/proc/self/environ` for its own auth token). Mitigations: container boundary,
per-invocation human gate, scoped/expiring tokens, revocability. Subscription
rate-limit reality: Somnus's sessions share Tyler's plan usage windows — heavy
Somnus coding can throttle Tyler's interactive use; the per-invocation gate is
the throttle.

## 4. Spend accounting (spool pattern)

`DATABASE_URL` stays scrubbed from the CC subprocess env, so cc.sh cannot reach
Postgres. Instead:

- cc.sh appends to `/app/workspace/.cc-spend.jsonl` (see §2).
- New pg-boss job `cc-spend-sweep` every 10 minutes (`scheduler.ts`, same patterns as existing jobs): rename the spool to `.cc-spend.jsonl.ingest` (atomic; concurrent cc.sh appends start a fresh spool), parse lines, insert into `spend_log`, delete the renamed file. Malformed lines are logged and dropped.
- Cap semantics: subscription sessions report ~$0 and effectively don't consume the $10/day API cap; rows still land in `spend_log` for observability (sessions/day, which repos, which models).

## 5. System prompt and permission changes (`agent/src/agent.ts`)

- The host-tools section of the system prompt becomes environment-conditional on `config.bashAutoApprove` (true == container):
  - **Container:** advertise `/app/agent/tools/cc.sh` with the clone → run → push → "send Tyler the compare URL `https://github.com/<owner>/<repo>/compare/<branch>`" workflow, note repos live in `/app/workspace/repos/`, note every cc.sh call needs Tyler's approval. No `term.sh`/`tmux` mention.
  - **Mac (dev):** existing text unchanged.
- `HOST_TOOL_RE` unchanged (`cc.sh` already matches). Everything else in `decidePermission` unchanged.

## 6. Docs

- `docs/DEPLOY.md`: new section — creating the fine-grained PAT (scopes, expiry, branch protection pointer), minting `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` on the Mac, adding both to the VM `.env`, and `docker compose --profile agent up -d --build` to roll the new image.
- `HANDOFF.md`: state update (VM cc.sh exists; Mac host tools are Mac-dev-only).

## 7. Verification

- Local: image builds; `cc.sh` passes `bash -n`; `docker run --rm somnus-agent ls /app/agent/tools/cc.sh /usr/local/bin/claude` (path may differ — verify `claude --version` runs).
- VM (after `.env` tokens added and image rolled):
  1. `cc.sh clone` of a small Tyler-owned repo → lands in `/app/workspace/repos/`, no token in `.git/config`.
  2. `cc.sh run` with a trivial prompt → JSON out with `session_id`; verify subscription billing (cost ~0 / no API spend recorded on the Anthropic console).
  3. `cc.sh push` to a scratch branch → branch visible on GitHub; pushing to `main` refused by the wrapper.
  4. Spool line written; after ≤10 min, `spend_log` row exists.
  5. End-to-end via Telegram: ask Somnus to clone + make a trivial change + push — every cc.sh call produces an approval prompt; automode does not bypass it.
  6. `docker compose restart agent` → `cc.sh resume` of the earlier session still works (claude_state volume).

## Out of scope

- term.sh / driving Tyler's Mac terminal from the VM (rejected option B).
- PR creation via GitHub API (compare-URL handoff is enough; revisit if friction logs say otherwise).
- Sidecar isolation for sessions (option C-heavy; container boundary deemed sufficient).
- Skill drafting for cc.sh workflows (the existing friction→skill pipeline will catch repeated patterns naturally).
