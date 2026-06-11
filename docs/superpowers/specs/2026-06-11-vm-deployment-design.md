# Somnus VM Deployment — Design

**Date:** 2026-06-11
**Status:** Approved by Tyler (brainstorming session "somnus")
**Goal:** Move Somnus from Tyler's Mac to an always-on VM for true 24/7/365 operation.

## Decisions made

| Decision | Choice | Rationale |
|---|---|---|
| Provider | Hetzner Cloud CPX11 (2 vCPU AMD x86, 2GB RAM, ~€4.5/mo), Ashburn or Hillsboro (US), Ubuntu 24.04 | Tyler wants US hosting (revised 2026-06-11 from CAX11/Falkenstein — ARM types are EU-only); 2GB is enough with a swapfile for build spikes; latency irrelevant for a long-polling Telegram bot |
| Backups | Nightly `pg_dump` to VM disk + pull to Mac over Tailscale | Tyler chose to skip object storage for now; WAL-G upgrade path stays open |
| Dev workflow | VM-only Telegram token; local dev via `npm run cli` against local DB | Avoids two-process long-poll conflicts (known gotcha); no second bot token to manage |
| Architecture | All-Docker: both `db` and `agent` as compose services | Container is the sandbox boundary; `restart: unless-stopped` replaces systemd; simplest deploy story |

## 1. VM provisioning (manual, one-time)

Documented step-by-step in `docs/DEPLOY.md` (to be written during implementation).

- Hetzner CPX11 (x86), Ashburn or Hillsboro (US), Ubuntu 24.04, 2G swapfile.
- Install Docker Engine + compose plugin, Tailscale.
- **Network lockdown (zero inbound ports, matching existing security model):**
  - Hetzner Cloud Firewall: drop ALL inbound traffic. Tailscale needs only outbound (UDP 41641 / DERP fallback over 443).
  - After Tailscale enrollment, bind sshd to the Tailscale IP only (`ListenAddress`), so SSH is unreachable from the public internet.
- `unattended-upgrades` enabled. That is the entire host footprint; everything else lives in containers.

## 2. Agent containerization

**`Dockerfile` at repo root**, multi-stage:

- **Build stage:** `node:22` — `npm ci` + `tsc` for both `brain-mcp/` and `agent/`.
- **Runtime stage:** `node:22-slim` plus `bash`, `git`, `curl`, `ca-certificates`, `procps` (the tools the agent's Bash tool reasonably needs). Production `node_modules` only.
- **Repo layout preserved** in the image (`/app/agent`, `/app/brain-mcp`) because `agent/src/agent.ts:33` spawns the brain MCP server at the relative path `../../brain-mcp/dist/index.js`.
- Runs as a non-root user.
- No docker socket, no host bind mounts. `workspace/` is a named volume at `/app/workspace`.

**Compose `agent` service** (added to existing `docker-compose.yml`):

- `depends_on: db: condition: service_healthy`
- `restart: unless-stopped`
- `env_file: .env`, with service-level overrides:
  - `BASH_AUTO_APPROVE=true` — the container is the sandbox; SDK Seatbelt/bubblewrap is disabled via the existing `sandboxSettings(dir, enabled=false)` path.
  - `DATABASE_URL=postgres://brain:<password>@db:5432/brain` — in-network hostname, not 127.0.0.1.
  - `WORKSPACE_DIR=/app/workspace`
  - `TZ=America/Denver` — dream cycle (04:00) and morning briefing (08:00) stay on Denver time.

`db` service unchanged. Its `127.0.0.1` port mapping is fine on the VM: reachable for `psql` pokes via SSH over Tailscale, invisible publicly.

**Security trade-off (accepted in brainstorming):** in-container bash auto-approve means a container escape's blast radius is the VM. Mitigations that remain: container has no host secrets beyond its own runtime env, no docker socket, scrubbed subprocess env (`sandbox.ts` layers 1–2 still apply), spend cap, Telegram allowlist, zero inbound ports.

## 3. Code changes (small)

1. `agent/package.json`: add `start:docker` script — same as `start` but without `--env-file=../.env` (compose injects env).
2. Verify the `BASH_AUTO_APPROVE=true` path truly bypasses the SDK OS sandbox: `sandboxSettings()` sets `failIfUnavailable: true`, which must not hard-fail in a slim container where Seatbelt/bubblewrap are unavailable. If `enabled: false` does not already skip the availability check, fix so it does.
3. Host tools `tools/cc.sh` / `tools/term.sh` are absent on the VM. They are already always-human-gated; confirm a request for them denies cleanly rather than crashing the turn.

## 4. Backups

- **VM cron, daily 04:30** (after the 04:00 dream cycle): `docker compose exec -T db pg_dump -Fc -U brain brain` → `/var/backups/somnus/brain-YYYY-MM-DD.dump`. Keep 7 days, delete older.
- **Mac launchd job:** when the Mac is awake, `scp` the latest dump over Tailscale to `~/Backups/somnus/`. Keep 30 days. Two machines, two retention windows.
- Plain-cron + scp is deliberate: the DB is small, restore is one command, and WAL-G/object storage can be layered on later without changing anything here.

## 5. Migration and cutover

1. Stop the local agent (permanently — the VM becomes the only Telegram consumer).
2. `pg_dump -Fc` the local brain DB → restore into the VM's fresh Postgres (the dump carries the schema; no reliance on the init script).
3. VM `.env`: production `TELEGRAM_BOT_TOKEN` lives ONLY here from now on. Generate a **fresh** `APPROVAL_SIGNING_SECRET` on the VM (`openssl rand -hex 32`); do not reuse the local one.
4. Local `.env` keeps DB credentials for dev (`npm run cli` against the local DB, which remains as a dev sandbox with a copy of the data).

## 6. Deploy tooling

`tools/deploy.sh`: SSH to the VM over Tailscale, `git pull`, `docker compose up -d --build`. Manual trigger only; no CI pipeline.

## 7. Verification

- **Smoke tests:** Telegram message round-trip; `/brief`; manual `/dream`; a Bash command runs auto-approved inside the container; file upload lands in the workspace inbox volume.
- **Reboot test:** reboot the VM; the stack self-heals via `restart: unless-stopped`.
- **Restore drill:** restore one nightly dump into a throwaway local DB and verify fact counts match.

## Out of scope

- Object storage / WAL-G continuous archiving (deferred; upgrade path preserved).
- Voice round-trip, ingestion, skill outcome tracking (separate roadmap items).
- CI/CD; deploys stay manual via `tools/deploy.sh`.
