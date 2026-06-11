# Somnus VM Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containerize the Somnus agent and produce everything needed to run it 24/7 on a Hetzner CAX11 VM: Dockerfile, compose service, deploy script, backup scripts, and a provisioning/migration runbook.

**Architecture:** All-Docker on one VM. The existing `db` compose service is joined by an `agent` service built from a repo-root Dockerfile that preserves the `/app/agent` + `/app/brain-mcp` layout (the agent spawns brain-mcp at the relative path `../../brain-mcp/dist/index.js`, see `agent/src/agent.ts:33`). The container is the Bash sandbox boundary: `BASH_AUTO_APPROVE=true` flows through the existing `sandboxSettings(WORKSPACE_DIR, !config.bashAutoApprove)` wiring (`agent/src/agent.ts:370`), so the SDK OS sandbox is cleanly disabled — no code change needed there. Backups are nightly `pg_dump` on the VM plus a launchd pull job on the Mac, both over Tailscale. Zero inbound ports.

**Tech Stack:** Docker multi-stage build (node:22 / node:22-slim), docker compose profiles, Tailscale, cron, launchd, pg_dump/pg_restore.

**Design spec:** `docs/superpowers/specs/2026-06-11-vm-deployment-design.md`

**Note on testing:** This is infrastructure work; there is no unit-test framework in this repo and most artifacts are config/scripts. Each task therefore uses *verification commands with expected output* in place of TDD's red/green, and `bash -n` syntax checks for shell scripts. Anything that can be exercised locally (image build, fail-fast boot, compose config) is exercised locally before commit.

---

### Task 1: `start:docker` script in agent/package.json

The container injects env via compose; `npm start`'s `--env-file=../.env` would fail on a missing file.

**Files:**
- Modify: `agent/package.json` (scripts block)

- [ ] **Step 1: Add the script**

In `agent/package.json`, change the `scripts` block to:

```json
  "scripts": {
    "build": "tsc",
    "dev": "node --env-file=../.env --import tsx src/index.ts",
    "start": "node --env-file=../.env dist/index.js",
    "start:docker": "node dist/index.js",
    "cli": "node --env-file=../.env dist/cli.js"
  },
```

- [ ] **Step 2: Verify JSON is valid and script resolves**

Run: `cd agent && node -e "console.log(require('./package.json').scripts['start:docker'])"`
Expected output: `node dist/index.js`

- [ ] **Step 3: Commit**

```bash
git add agent/package.json
git commit -m "feat: add start:docker script (container injects env, no --env-file)"
```

---

### Task 2: .dockerignore

Keep the build context small and make sure secrets and host-only junk never reach the image.

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

```
# Secrets — must never enter the image
.env

# Rebuilt inside the image
**/node_modules
**/dist

# Host-only / irrelevant to the agent image
.git
workspace
research
docs
db
tools
ops
*.md
.claude
```

- [ ] **Step 2: Verify the file lists .env**

(The real proof — `.env` absent from the image — is Task 3 Step 5; no Dockerfile exists yet at this point.)

Run: `grep -c "^\.env$" .dockerignore`
Expected output: `1`

- [ ] **Step 3: Commit**

```bash
git add .dockerignore
git commit -m "chore: dockerignore — keep secrets and host-only dirs out of the image"
```

---

### Task 3: Dockerfile (repo root, multi-stage)

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Somnus agent image. Layout mirrors the repo (/app/agent, /app/brain-mcp)
# because the agent spawns brain-mcp at ../../brain-mcp/dist/index.js
# relative to agent/dist/ (agent/src/agent.ts:33).

FROM node:22-slim AS build
WORKDIR /app
COPY brain-mcp/package.json brain-mcp/package-lock.json brain-mcp/
COPY agent/package.json agent/package-lock.json agent/
RUN cd brain-mcp && npm ci && cd ../agent && npm ci
COPY brain-mcp/ brain-mcp/
COPY agent/ agent/
RUN cd brain-mcp && npm run build && cd ../agent && npm run build

FROM node:22-slim
# Minimal toolset for the agent's Bash tool. The container is the sandbox
# boundary (BASH_AUTO_APPROVE=true); keep the surface small on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY brain-mcp/package.json brain-mcp/package-lock.json brain-mcp/
COPY agent/package.json agent/package-lock.json agent/
RUN cd brain-mcp && npm ci --omit=dev && cd ../agent && npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/brain-mcp/dist brain-mcp/dist
COPY --from=build /app/agent/dist agent/dist
RUN mkdir -p /app/workspace && chown -R node:node /app/workspace
USER node
WORKDIR /app/agent
CMD ["npm", "run", "start:docker"]
```

- [ ] **Step 2: Build the image locally**

The Mac is arm64, same architecture as the CAX11 — a local build is representative.

Run: `docker build -t somnus-agent .`
Expected: build completes; both `npm run build` (tsc) steps succeed.

- [ ] **Step 3: Verify image layout and user**

Run: `docker run --rm somnus-agent sh -c "whoami && ls /app/brain-mcp/dist/index.js /app/agent/dist/index.js"`
Expected output:
```
node
/app/agent/dist/index.js
/app/brain-mcp/dist/index.js
```

- [ ] **Step 4: Verify fail-fast boot without env (config.ts contract)**

Run: `docker run --rm somnus-agent; echo "exit=$?"`
Expected: `Missing required env var: TELEGRAM_BOT_TOKEN` and `exit=1` — proves the container starts node, loads config, and fails closed instead of half-running.

- [ ] **Step 5: Verify .env is not in the image**

Run: `docker run --rm somnus-agent sh -c "ls /app/.env 2>&1 || true"`
Expected: `ls: cannot access '/app/.env': No such file or directory`

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "feat: multi-stage agent image — repo layout preserved, non-root, slim toolset"
```

---

### Task 4: compose `agent` service (opt-in profile)

The `profiles: ["agent"]` guard means the Mac's habitual `docker compose up -d db` (or even bare `up -d`) never starts a second Telegram consumer — the known long-poll-conflict gotcha. Only the VM runs `docker compose --profile agent up -d`.

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the agent service and workspace volume**

Replace the trailing comment block and `volumes:` section of `docker-compose.yml` (lines 24–30) so the file ends like this (db service body stays untouched above):

```yaml
  # Agent runtime: Telegram bot + Claude Agent SDK + brain-mcp (spawned via
  # stdio inside this container). Opt-in profile so local `up -d` on the Mac
  # can never start a second long-poll consumer — only the VM runs
  # `docker compose --profile agent up -d`.
  agent:
    build: .
    restart: unless-stopped
    profiles: ["agent"]
    depends_on:
      db:
        condition: service_healthy
    env_file: .env
    environment:
      # The container IS the sandbox boundary (design spec §2). This flips
      # sandboxSettings() off via the existing config.bashAutoApprove wiring.
      BASH_AUTO_APPROVE: "true"
      # In-network hostname; overrides the localhost URL in .env.
      DATABASE_URL: postgres://brain:${DB_PASSWORD}@db:5432/brain
      WORKSPACE_DIR: /app/workspace
      TZ: ${TZ:-America/Denver}
    volumes:
      - agent_workspace:/app/workspace

  # Later (see research/README.md build order):
  #   wal-archive: WAL-G continuous archiving to object storage

volumes:
  pg_data:
  agent_workspace:
```

- [ ] **Step 2: Validate compose config**

Run: `docker compose --profile agent config --quiet && echo OK`
Expected output: `OK`

- [ ] **Step 3: Verify profile guard — agent absent without the flag**

Run: `docker compose config --services`
Expected output: `db` only (no `agent` line).

Run: `docker compose --profile agent config --services`
Expected output: `db` and `agent`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: agent compose service behind opt-in profile

Profile guard makes the long-poll conflict (two bot processes fighting
over Telegram updates) structurally impossible from the Mac: plain
'docker compose up -d' never starts the agent; only the VM opts in."
```

---

### Task 5: tools/deploy.sh

**Files:**
- Create: `tools/deploy.sh`

- [ ] **Step 1: Write `tools/deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploy Somnus to the VM over Tailscale: fast-forward pull, rebuild, restart.
# Usage: tools/deploy.sh [ssh-host]   (default: somnus-vm)
set -euo pipefail

VM_HOST="${1:-somnus-vm}"

ssh "$VM_HOST" 'set -euo pipefail
  cd ~/somnus
  git pull --ff-only
  docker compose --profile agent up -d --build
  docker compose --profile agent ps'
```

- [ ] **Step 2: Syntax-check and make executable**

Run: `bash -n tools/deploy.sh && chmod +x tools/deploy.sh && echo OK`
Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add tools/deploy.sh
git commit -m "feat: deploy.sh — manual deploy over Tailscale (pull, rebuild, restart)"
```

---

### Task 6: Backup scripts (VM cron + Mac launchd pull)

**Files:**
- Create: `ops/vm/backup.sh`
- Create: `ops/mac/pull-somnus-backup.sh`
- Create: `ops/mac/com.tyler.somnus-backup-pull.plist`

- [ ] **Step 1: Write `ops/vm/backup.sh`**

```bash
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
```

- [ ] **Step 2: Write `ops/mac/pull-somnus-backup.sh`**

```bash
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
```

- [ ] **Step 3: Write `ops/mac/com.tyler.somnus-backup-pull.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tyler.somnus-backup-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/tylergrimes/adhd_squared/ops/mac/pull-somnus-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/somnus-backup-pull.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/somnus-backup-pull.err</string>
</dict>
</plist>
```

- [ ] **Step 4: Syntax-check everything**

Run: `bash -n ops/vm/backup.sh && bash -n ops/mac/pull-somnus-backup.sh && plutil -lint ops/mac/com.tyler.somnus-backup-pull.plist && chmod +x ops/vm/backup.sh ops/mac/pull-somnus-backup.sh`
Expected output: `ops/mac/com.tyler.somnus-backup-pull.plist: OK`

- [ ] **Step 5: Commit**

```bash
git add ops/
git commit -m "feat: backup scripts — nightly pg_dump on VM, daily launchd pull to Mac

Plain cron+scp by choice (design spec §4): DB is small, restore is one
command, WAL-G/object storage can layer on later without changes here."
```

---

### Task 7: docs/DEPLOY.md — provisioning, migration, cutover runbook

This is the manual-steps companion to the automated artifacts above. Everything Tyler runs by hand lives here.

**Files:**
- Create: `docs/DEPLOY.md`

- [ ] **Step 1: Write `docs/DEPLOY.md`**

````markdown
# Somnus VM Deployment Runbook

Design: `docs/superpowers/specs/2026-06-11-vm-deployment-design.md`.
One-time provisioning + migration steps. Day-to-day deploys: `tools/deploy.sh`.

## 1. Provision the VM (Hetzner)

1. Hetzner Cloud console → new project "somnus" → add server:
   **CAX11** (2 vCPU Ampere ARM, 4GB), **Falkenstein**, **Ubuntu 24.04**,
   add your SSH key.
2. Hetzner Cloud Firewall: create firewall "somnus-deny-all" with **no inbound
   rules at all** (default deny) and apply it to the server. Tailscale needs
   only outbound. Public SSH works until the firewall applies — do step 3
   promptly.
3. First login (`ssh root@<public-ip>` — do this BEFORE applying the firewall,
   or use the Hetzner web console):

   ```bash
   # user
   adduser somnus && usermod -aG sudo somnus
   rsync -a ~/.ssh /home/somnus/ && chown -R somnus:somnus /home/somnus/.ssh

   # tailscale
   curl -fsSL https://tailscale.com/install.sh | sh
   tailscale up   # authenticate; note the 100.x.y.z IP; name the node somnus-vm

   # docker (official repo)
   apt-get update && apt-get install -y ca-certificates curl
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
     https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
     > /etc/apt/sources.list.d/docker.list
   apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
   usermod -aG docker somnus

   # auto security updates
   apt-get install -y unattended-upgrades
   dpkg-reconfigure -plow unattended-upgrades

   # backups dir (ops/vm/backup.sh writes here as user somnus)
   mkdir -p /var/backups/somnus && chown somnus:somnus /var/backups/somnus
   ```

4. Lock SSH to Tailscale: in `/etc/ssh/sshd_config` set

   ```
   ListenAddress <tailscale-100.x.y.z-ip>
   PasswordAuthentication no
   PermitRootLogin no
   ```

   then `systemctl restart ssh`. **Verify `ssh somnus@somnus-vm` works over
   Tailscale BEFORE applying the deny-all firewall.** Once verified, apply the
   firewall. From here the box has zero public ports.

5. Mac `~/.ssh/config`:

   ```
   Host somnus-vm
     HostName somnus-vm        # Tailscale MagicDNS
     User somnus
   ```

## 2. Get the repo onto the VM

Private repo → read-only deploy key:

```bash
# on the VM as somnus
ssh-keygen -t ed25519 -f ~/.ssh/somnus-deploy -N "" -C "somnus-vm deploy key"
cat ~/.ssh/somnus-deploy.pub
# → GitHub repo → Settings → Deploy keys → add (read-only)

cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/somnus-deploy
EOF

git clone git@github.com:tyler-grimes/somnus.git ~/somnus
```

## 3. VM .env

`cp ~/somnus/.env.example ~/somnus/.env` and fill in:

- `DB_PASSWORD` — **new** password, not the local one.
- `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID` — the
  production values. After cutover the bot token lives ONLY here.
- `APPROVAL_SIGNING_SECRET=$(openssl rand -hex 32)` — fresh, never reuse local.
- `OPENAI_API_KEY` if available (vector retrieval arm).
- Omit `DB_PORT` (5432 default is fine on the VM; 5433 was a Mac-only conflict).
- `DATABASE_URL` can stay as the example value — the compose agent service
  overrides it with the in-network `@db:5432` URL.

`chmod 600 ~/somnus/.env`

## 4. Migrate the brain (production data!)

Order matters: the dump restores into a schema the init script already
created, so use `--clean --if-exists`.

```bash
# 1. Mac: stop the local agent FIRST (tmux pane 1:1.0, Ctrl-C) so no facts
#    are written after the dump. Leave the local db container running.
docker compose exec -T db pg_dump -Fc -U brain brain > /tmp/somnus-migration.dump

# 2. Ship it
scp /tmp/somnus-migration.dump somnus-vm:/tmp/

# 3. VM: start db only, wait healthy, restore
cd ~/somnus && docker compose up -d db
docker compose ps   # wait for "healthy"
docker compose exec -T db pg_restore -U brain -d brain --clean --if-exists --no-owner < /tmp/somnus-migration.dump

# 4. Sanity: fact count should match the Mac's
docker compose exec -T db psql -U brain -d brain -c "select count(*) from facts;"

# 5. Clean up the dump copies
rm /tmp/somnus-migration.dump   # on both machines
```

## 5. Start the agent + cron

```bash
# VM
cd ~/somnus && docker compose --profile agent up -d --build
docker compose --profile agent logs -f agent   # watch boot: initPolicy → scheduler → bot

# backup cron
crontab -e
# add: 30 4 * * * /home/somnus/somnus/ops/vm/backup.sh >> /var/log/somnus-backup.log 2>&1
```

Mac launchd pull job:

```bash
cp ops/mac/com.tyler.somnus-backup-pull.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tyler.somnus-backup-pull.plist
```

## 6. Cutover checklist (verification — design spec §7)

- [ ] Telegram message → reply round-trip
- [ ] `/brief` returns a briefing
- [ ] `/dream` runs end-to-end (check logs)
- [ ] Ask Somnus to run a Bash command — runs WITHOUT an approval prompt
      (container automode) and `env` shows no secrets (scrub layers intact)
- [ ] Ask Somnus to run `term.sh list` — denied/asks gracefully, no crash
      (host tools don't exist on the VM)
- [ ] Send a photo → lands in the workspace inbox volume
- [ ] `sudo reboot` → stack self-heals, bot answers again
- [ ] Next morning: dump exists in `/var/backups/somnus/`; after 09:00 with
      the Mac awake, copy exists in `~/Backups/somnus/`
- [ ] Restore drill on the Mac:
      `createdb -h 127.0.0.1 -p 5433 -U brain brain_drill` then
      `pg_restore -h 127.0.0.1 -p 5433 -U brain -d brain_drill --no-owner ~/Backups/somnus/brain-<date>.dump`
      and compare `select count(*) from facts;`
- [ ] Local repo `.env`: confirm the Telegram token is removed (CLI dev
      needs only DATABASE_URL + ANTHROPIC_API_KEY)

## 7. Day-to-day

- Deploy: `tools/deploy.sh` (from the Mac)
- Logs: `ssh somnus-vm 'cd ~/somnus && docker compose --profile agent logs -f --tail 100 agent'`
- psql: `ssh somnus-vm 'cd ~/somnus && docker compose exec -T db psql -U brain -d brain'`
````

- [ ] **Step 2: Verify internal references**

Run: `grep -o 'ops/[a-z/.-]*\.sh\|tools/deploy.sh' docs/DEPLOY.md | sort -u`
Expected output (all three exist in the repo after Tasks 5–6):
```
ops/mac/pull-somnus-backup.sh
ops/vm/backup.sh
tools/deploy.sh
```

(Note: DEPLOY.md references `ops/vm/backup.sh` at the VM path `/home/somnus/somnus/...` in the cron line — that's the clone path on the VM, correct as written.)

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY.md
git commit -m "docs: VM provisioning, migration, and cutover runbook"
```

---

### Task 8: Update HANDOFF.md state

**Files:**
- Modify: `HANDOFF.md` (the "Not done / next" list, item 4; and the "State of the world" Done list)

- [ ] **Step 1: Update item 4 of "Not done / next"**

Replace:

```
4. VM deployment (24/7/365 target): containerize agent (compose `agent`
   service stubbed), `BASH_AUTO_APPROVE=true` only inside container, WAL-G
   backups to object storage before real data accumulates further.
```

with:

```
4. VM deployment (24/7/365 target): deployment artifacts DONE (Dockerfile,
   compose `agent` service behind `--profile agent`, `tools/deploy.sh`,
   backup scripts in `ops/`, runbook `docs/DEPLOY.md`) — remaining: provision
   the Hetzner CAX11 and execute the runbook. WAL-G/object storage
   deliberately deferred (nightly pg_dump + Mac pull for now).
```

- [ ] **Step 2: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — VM deployment artifacts done, runbook execution remains"
```

---

## Execution notes

- Tasks 1–3 are ordered (script → ignore → image build uses both). Task 4
  depends on Task 3 (build context). Tasks 5–7 are independent of each other
  but Task 7's verification step expects 5 and 6 to exist. Task 8 last.
- Task 3 steps 2–5 and Task 4 steps 2–3 run real docker commands locally —
  Docker Desktop must be running.
- Nothing in this plan touches the running local agent or the production DB;
  the migration itself is manual runbook work (DEPLOY.md §4) that Tyler
  executes when the VM exists.
