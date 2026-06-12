# Term Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Somnus (VM container) can run `term.sh list|peek|send|keys` against the Mac's tmux panes over a Tailscale-only, forced-command SSH key, every call Telegram-gated.

**Architecture:** A container-side `agent/tools/term.sh` SSHes to the Mac with a dedicated key. On the Mac, that key's `authorized_keys` entry forces `tools/term-bridge.sh`, which allow-lists `$SSH_ORIGINAL_COMMAND` to `list|peek|send|keys` and execs the real `tools/term.sh`. The private key is a host file bind-mounted read-only into the container; its `.ssh/` path keeps it unreadable by the agent's own tools. No `decidePermission` change — `HOST_TOOL_RE` already gates `term.sh`.

**Tech Stack:** bash, OpenSSH forced commands, tmux, Docker Compose bind mounts, Tailscale.

**Design spec:** `docs/superpowers/specs/2026-06-12-term-bridge-design.md`

**Grounding facts (verified):**
- Existing `tools/term.sh` (Mac) implements `list|peek|send|keys` via tmux; unchanged by this work.
- `HOST_TOOL_RE = /(^|[\s/;&|])(term\.sh|cc\.sh|tmux)(\s|$)/` (agent.ts:50) already routes any `term.sh` to `requestApproval`, no automode bypass, no standing rule.
- `SENSITIVE_PATH_RE` matches `\.ssh\/` (agent.ts:43-44) → the agent's own Read/Bash cannot read the key.
- Container prompt closing line to replace: `agent/src/agent.ts:275` ("There is no term.sh or tmux on this machine…"), inside the `config.bashAutoApprove` branch of `codingPromptSection()`.
- Compose agent volumes end at `docker-compose.yml:68` (`claude_state:/home/node/.claude`).
- Mac identity: user `tylergrimes`, tailnet IP `100.83.186.28`. VM tailnet IP `100.96.104.68`. VM repo path `~/somnus`; Mac repo path `/Users/tylergrimes/adhd_squared`.
- Forced SSH commands run with a minimal PATH — `term-bridge.sh` must set PATH so `tmux` (Homebrew, `/opt/homebrew/bin`) resolves.

**Note on testing:** infra/shell work, no unit framework. Tasks use `bash -n` + behavior assertions with expected output. The live end-to-end (Tasks 7–8) is manual because it needs the Mac's Remote Login + authorized_keys (Tyler's two manual steps).

---

### Task 1: Mac-side `tools/term-bridge.sh` (forced-command allowlist)

**Files:**
- Create: `tools/term-bridge.sh`

- [ ] **Step 1: Write `tools/term-bridge.sh`**

```bash
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

# Forced commands inherit a minimal PATH; tmux lives in Homebrew.
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

# Re-split the original request into args and run the real term.sh. word
# splitting here is intentional: term.sh's own quoting handles the text arg.
# shellcheck disable=SC2086
exec "$HERE/term.sh" $req
```

- [ ] **Step 2: Syntax check + exec bit**

Run: `bash -n tools/term-bridge.sh && chmod +x tools/term-bridge.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Behavior test — refuses non-allowlisted, accepts allowlisted**

Run: `SSH_ORIGINAL_COMMAND="rm -rf /tmp/x" tools/term-bridge.sh; echo "exit=$?"`
Expected: `term-bridge: refused ('rm' not in list|peek|send|keys)` and `exit=1`

Run: `SSH_ORIGINAL_COMMAND="list" tools/term-bridge.sh; echo "exit=$?"`
Expected: term.sh's list output (or `no tmux server running` if none) and `exit=0` — proves the allowlisted path execs term.sh.

- [ ] **Step 4: Commit**

```bash
git add tools/term-bridge.sh
git commit -m "feat: term-bridge.sh — SSH forced-command allowlist for the term bridge

Restricts the Somnus term-bridge key to term.sh list|peek|send|keys via
\$SSH_ORIGINAL_COMMAND; anything else is refused. Sets PATH so tmux
resolves under a forced command's minimal env."
```

---

### Task 2: Container-side `agent/tools/term.sh` (SSH wrapper)

**Files:**
- Create: `agent/tools/term.sh`

- [ ] **Step 1: Write `agent/tools/term.sh`**

```bash
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
```

- [ ] **Step 2: Syntax check + exec bit**

Run: `bash -n agent/tools/term.sh && chmod +x agent/tools/term.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Behavior test — fails closed without env/key**

Run: `( unset MAC_SSH_HOST MAC_SSH_USER; agent/tools/term.sh list ) 2>&1; echo "exit=$?"`
Expected: `MAC_SSH_HOST not set` and `exit=1` (the `:?` guard fires before any ssh).

Run: `MAC_SSH_HOST=x MAC_SSH_USER=y TERM_BRIDGE_KEY=/nonexistent agent/tools/term.sh list 2>&1; echo "exit=$?"`
Expected: `term.sh: bridge key not readable at /nonexistent` and `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add agent/tools/term.sh
git commit -m "feat: container term.sh — forward tmux control to the Mac over SSH

Wrapper SSHes to the Mac with the dedicated bridge key; the Mac's forced
command maps it to the real term.sh. Fails closed if the key or Mac
host/user env is missing. Matches HOST_TOOL_RE so the harness gates it."
```

---

### Task 3: Ship the wrapper in the image (Dockerfile)

`agent/tools/cc.sh` is already copied via `COPY agent/tools/ agent/tools/`, so the new `agent/tools/term.sh` ships automatically. This task only ensures the container has a writable known_hosts and an `~/.ssh` dir owned by `node` (the bind-mounted key is read-only; `accept-new` must write the Mac's host key somewhere).

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Ensure `node`-owned `~/.ssh` exists in the image**

In `Dockerfile`, find the runtime-stage line that creates the workspace/claude dirs:

```dockerfile
RUN mkdir -p /app/workspace /home/node/.claude && chown -R node:node /app/workspace /home/node/.claude
```

Change it to also create `/home/node/.ssh` (0700) so `StrictHostKeyChecking=accept-new` can write `known_hosts`, and the read-only key bind-mount lands in a node-owned dir:

```dockerfile
RUN mkdir -p /app/workspace /home/node/.claude /home/node/.ssh \
    && chown -R node:node /app/workspace /home/node/.claude /home/node/.ssh \
    && chmod 700 /home/node/.ssh
```

- [ ] **Step 2: Build the image**

Run: `docker build -t somnus-agent .`
Expected: build completes.

- [ ] **Step 3: Verify `~/.ssh` and the shipped wrapper**

Run: `docker run --rm somnus-agent sh -c "ls -ld /home/node/.ssh && ls -l /app/agent/tools/term.sh"`
Expected: `/home/node/.ssh` is `drwx------ … node node`; `term.sh` present and `-rwxr-xr-x`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat: node-owned ~/.ssh in image for the term-bridge key + known_hosts"
```

---

### Task 4: Bind-mount the key + Mac env (docker-compose.yml)

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the key mount and Mac env to the `agent` service**

The agent service `volumes:` currently ends with `- claude_state:/home/node/.claude` (line ~68). Add the read-only key mount right after it:

```yaml
      - claude_state:/home/node/.claude
      # term bridge: dedicated SSH key (host file, 0600), read-only in-container.
      # Path is under .ssh/ so SENSITIVE_PATH_RE keeps the agent from reading it.
      - /home/somnus/.ssh/term-bridge:/home/node/.ssh/term-bridge:ro
```

In the agent service `environment:` block (where `BASH_AUTO_APPROVE`, `WORKSPACE_DIR`, `TZ` are), add the Mac coordinates so the wrapper knows where to reach:

```yaml
      MAC_SSH_HOST: ${MAC_SSH_HOST:-100.83.186.28}
      MAC_SSH_USER: ${MAC_SSH_USER:-tylergrimes}
```

- [ ] **Step 2: Validate compose**

Run: `docker compose --profile agent config --quiet && echo OK`
Expected: `OK`

(Note: `docker compose config` does not require the host key file to exist yet; the file is created on the VM in Task 7. Local validation passes regardless.)

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: mount term-bridge key (ro) + Mac SSH coordinates into agent"
```

---

### Task 5: Advertise term.sh in the container prompt (agent.ts)

**Files:**
- Modify: `agent/src/agent.ts` (line 275, container branch of `codingPromptSection()`)

- [ ] **Step 1: Replace the "no term.sh" closing line**

Current line 275 (inside the `if (config.bashAutoApprove)` branch, just before `</coding>`):

```
There is no term.sh or tmux on this machine: you cannot see or control Tyler's terminal sessions from here. If Tyler asks for that, tell him it requires his Mac.
```

Replace that single line with:

```
You can control the live tmux sessions on Tyler's Mac over a bridged term.sh (every call needs Tyler's Telegram approval, even in automode):
- /app/agent/tools/term.sh list — Tyler's Mac tmux panes with their running command and path
- /app/agent/tools/term.sh peek <pane> [lines] — read a pane's recent output
- /app/agent/tools/term.sh send <pane> "<text>" — type text + Enter into a pane (e.g. answer a Claude Code session's question)
- /app/agent/tools/term.sh keys <pane> <keys> — raw keys (Escape, C-c)
ALWAYS peek before you send — confirm what's running and its state. These are Tyler's real terminals; act like you're typing on his keyboard, because you are. The Mac must be awake and reachable — if term.sh fails, show Tyler the real error, don't guess at fixes.
```

- [ ] **Step 2: Build + test**

Run: `cd agent && npm run build && npm test 2>&1 | grep -E "pass|fail"`
Expected: tsc clean; `pass 10` / `fail 0`.

- [ ] **Step 3: Commit**

```bash
git add agent/src/agent.ts
git commit -m "feat: container prompt advertises the bridged term.sh (Mac tmux control)"
```

---

### Task 6: Docs — DEPLOY.md §9 + HANDOFF.md

**Files:**
- Modify: `docs/DEPLOY.md`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Append `## 9. Term bridge` to `docs/DEPLOY.md`**

````markdown

## 9. Term bridge — control the Mac's tmux from Somnus

Somnus can drive the Mac's tmux Claude Code sessions via `/app/agent/tools/term.sh`
(every call Telegram-gated). One-time setup:

1. **Generate the keypair** (run from the Mac repo):
   ```bash
   ssh-keygen -t ed25519 -f /tmp/somnus-term-bridge -N "" -C "somnus-term-bridge"
   ```
2. **Stage the private key on the VM** (host file, never in .env/image):
   ```bash
   scp /tmp/somnus-term-bridge somnus-vm:/home/somnus/.ssh/term-bridge
   ssh somnus-vm 'chmod 600 /home/somnus/.ssh/term-bridge'
   ```
3. **Authorize the public key on the Mac** — append ONE line to
   `~/.ssh/authorized_keys` (replace `<PUBKEY>` with the contents of
   `/tmp/somnus-term-bridge.pub`):
   ```
   command="/Users/tylergrimes/adhd_squared/tools/term-bridge.sh",from="100.96.104.68",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <PUBKEY>
   ```
4. **Enable Remote Login on the Mac:** `sudo systemsetup -setremotelogin on`
   (or System Settings → General → Sharing → Remote Login).
5. **Delete the temp keypair from the Mac:** `rm /tmp/somnus-term-bridge*`
6. **Add Mac coordinates to the VM `.env`** (compose has defaults, but make them
   explicit):
   ```
   MAC_SSH_HOST=100.83.186.28
   MAC_SSH_USER=tylergrimes
   ```
7. **Roll the image:** `tools/deploy.sh`

Verify: ask Somnus (Telegram) to run `term.sh list` — expect an approval prompt,
then your Mac's panes. From the VM, `ssh -i /home/somnus/.ssh/term-bridge
tylergrimes@100.83.186.28 "whoami"` must be REFUSED by the forced command.

Revoke anytime: delete the `authorized_keys` line on the Mac.
````

- [ ] **Step 2: Update `HANDOFF.md` host-tools bullet**

Find the `tools/cc.sh + tools/term.sh` bullet in the Repo-layout section. Replace its `term.sh` clause so it reads (keep the cc.sh content intact):

```
- `tools/cc.sh` + `tools/term.sh` + `tools/term-bridge.sh` — Mac host tools.
  `term-bridge.sh` is the SSH forced-command that lets the VM drive the Mac's
  tmux: the container's `agent/tools/term.sh` SSHes over Tailscale with a
  dedicated key (host file `/home/somnus/.ssh/term-bridge`, bind-mounted ro),
  and the Mac authorized_keys entry pins term-bridge.sh which allow-lists
  list|peek|send|keys → real term.sh. `agent/tools/cc.sh` = in-container
  Claude Code sessions (see its own notes). ALL cc.sh/term.sh/tmux calls are
  ALWAYS human-gated, never automode or standing rules. Setup: DEPLOY.md §9.
```

- [ ] **Step 3: Verify references**

Run: `grep -c "term-bridge" docs/DEPLOY.md HANDOFF.md`
Expected: ≥1 in each.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOY.md HANDOFF.md
git commit -m "docs: term-bridge setup runbook (DEPLOY §9) + HANDOFF host-tools note"
```

---

### Task 7: Deploy + key provisioning (controller/Tyler — manual)

Executed from the main session with Tyler; needs his macOS settings and the key material.

- [ ] **Step 1:** Push main; the controller generates the keypair, `scp`s the private key to `/home/somnus/.ssh/term-bridge` (chmod 600), and gives Tyler the exact `authorized_keys` line.
- [ ] **Step 2:** Tyler enables Remote Login and pastes the `authorized_keys` line (DEPLOY.md §9 steps 3–4).
- [ ] **Step 3:** Add `MAC_SSH_HOST`/`MAC_SSH_USER` to the VM `.env`; run `tools/deploy.sh`.

---

### Task 8: Live verification (controller/Tyler — manual)

- [ ] **Step 1: Containment** — the real boundary against a *compromised* agent is the **Mac forced-command**, not the in-container key file. Verify it: `ssh -i /home/somnus/.ssh/term-bridge tylergrimes@100.83.186.28 "id"` (arbitrary command) must be REFUSED by `term-bridge.sh`. Honest caveat (correcting the spec's parenthetical): in the container the OS sandbox is OFF and non-host-tool Bash auto-approves, so `SENSITIVE_PATH_RE` only stops a *naive* read of the key (`cat …/.ssh/term-bridge` is denied by the pre-filter) — it is a guardrail for the cooperative agent, not a hard wall; a determined/compromised agent in the container can reach the key or call `ssh` directly. That is exactly why the forced-command + `from=`-IP + Mac-must-be-awake + revocability are the controls that actually matter, and why the Telegram gate is the control for *normal* operation. Confirm the naive read is at least pre-filtered: `docker compose exec -T agent sh -c 'cat /home/node/.ssh/term-bridge'` run *through the agent's Bash tool* (via Telegram) is denied; run directly via `docker exec` it succeeds (the wrapper needs it).
- [ ] **Step 2: Function** — `docker compose exec -T agent /app/agent/tools/term.sh list` returns the Mac's panes; `peek <pane>` reads output; `send <scratch-pane> "echo hi"` appears in that pane; `keys <pane> C-c` interrupts.
- [ ] **Step 3: Gate** — via Telegram, ask Somnus to `term.sh list`; confirm an approval prompt fires even with `/auto` on.
- [ ] **Step 4: Revocation drill** — remove the `authorized_keys` line; `term.sh list` from the VM fails closed; restore the line.

---

## Execution notes

- Tasks 1–6 are codeable/committable now and independent of the Mac/VM (compose `config` and image build don't need the key file). Tasks 7–8 are manual and run last, with Tyler.
- Task 3 builds the image locally (Docker Desktop running).
- Nothing here changes `decidePermission`; the gate is the pre-existing `HOST_TOOL_RE` path.
- The key file `/home/somnus/.ssh/term-bridge` does not exist until Task 7; a `docker compose up` before then will fail the bind mount, so do not deploy until the key is staged (Task 7 stages it before deploy).
