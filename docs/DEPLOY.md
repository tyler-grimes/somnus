# Somnus VM Deployment Runbook

Design: `docs/superpowers/specs/2026-06-11-vm-deployment-design.md`.
One-time provisioning + migration steps. Day-to-day deploys: `tools/deploy.sh`.

## 1. Provision the VM (Hetzner)

1. Hetzner Cloud console → new project "somnus" → add server:
   **CPX11** (2 vCPU AMD x86, 2GB), **Ashburn or Hillsboro (US)**, **Ubuntu
   24.04**, add your SSH key.
2. Hetzner Cloud Firewall: create firewall "somnus-deny-all" with **no inbound
   rules at all** (default deny) but do **not** attach it to the server yet —
   public SSH must keep working until Tailscale SSH is verified in step 4.
   Tailscale needs only outbound.
3. First login (`ssh root@<public-ip>` over public SSH — the firewall is not
   attached yet):

   ```bash
   # swap — CPX11 has 2GB RAM; npm ci during image builds spikes past it
   fallocate -l 2G /swapfile && chmod 600 /swapfile
   mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab

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
   touch /var/log/somnus-backup.log && chown somnus:somnus /var/log/somnus-backup.log
   ```

4. Lock SSH to Tailscale. Ubuntu's sshd is **socket-activated** — a
   `ListenAddress` in `sshd_config` is silently ignored; the bind lives on
   `ssh.socket`. `FreeBind` lets the socket bind the Tailscale IP even if
   tailscaled hasn't brought it up yet at boot (no boot-order race):

   ```bash
   mkdir -p /etc/systemd/system/ssh.socket.d
   printf '[Socket]\nListenStream=\nListenStream=<tailscale-100.x.y.z-ip>:22\nFreeBind=true\n' \
     > /etc/systemd/system/ssh.socket.d/tailscale-only.conf
   printf 'PasswordAuthentication no\nPermitRootLogin no\n' \
     > /etc/ssh/sshd_config.d/99-somnus-hardening.conf
   systemctl daemon-reload && systemctl restart ssh.socket
   ```

   **Verify `ssh somnus@somnus-vm` works over Tailscale BEFORE applying the
   deny-all firewall.** Once verified, apply the firewall. From here the box
   has zero public ports.

5. Mac `~/.ssh/config`:

   ```
   Host somnus-vm
     HostName somnus-vm        # Tailscale MagicDNS
     User somnus
   ```

## 2. Get the repo onto the VM

Exit the root session and reconnect as the service user: `ssh somnus@somnus-vm`.
All remaining steps run as `somnus`.

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

# 5. Clean up the dump copies — run on the VM AND on the Mac
rm /tmp/somnus-migration.dump
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

Mac launchd pull job (runs `ops/mac/pull-somnus-backup.sh` daily at 09:00):

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

## 8. Coding sessions (cc.sh) — one-time credential setup

Somnus runs headless Claude Code sessions inside its container
(`/app/agent/tools/cc.sh`; every invocation needs a Telegram approval).
Two credentials in the VM `.env` (never on the Mac, never in git):

1. **GitHub PAT** — github.com → Settings → Developer settings →
   Fine-grained tokens → Generate: Resource owner = you; Repository access =
   the repos Somnus may touch; Permissions = Contents (Read and write) +
   Metadata (Read-only); Expiration 90 days. Then enable branch protection on
   `main` for those repos (Settings → Branches → Add rule). Add to VM `.env`:
   `GITHUB_TOKEN=github_pat_...`
   Repos under another owner (e.g. the `neurotime` org) need their own PAT —
   same scopes, resource owner = the org — added as `GITHUB_TOKEN_<OWNER>`
   (uppercase, `-`→`_`): `GITHUB_TOKEN_NEUROTIME=github_pat_...`. cc.sh picks
   the token by repo owner; `GITHUB_TOKEN` is the fallback.

2. **Claude subscription token** — on the Mac run `claude setup-token`,
   complete the browser flow, copy the token. Add to VM `.env`:
   `CLAUDE_CODE_OAUTH_TOKEN=...`  (≈1-year expiry; revoke anytime at
   claude.ai → Settings. Sessions share your plan's usage limits.)

Roll the image: `tools/deploy.sh`.

Verification:
- Ask Somnus (Telegram) to clone a small repo and make a trivial change —
  each cc.sh call should produce an approval prompt, even in automode.
- `ssh somnus-vm 'docker compose exec agent sh -c "cat /app/workspace/repos/<repo>/.git/config"'`
  — no token anywhere in it.
- Push test: have Somnus push branch `cc-test` and send the compare URL;
  verify pushing to `main` is refused by the wrapper.
- After ≤10 min: `docker compose exec -T db psql -U brain -d brain -c
  "select model, purpose, cost_usd from spend_log where model='claude-code-session' order by created_at desc limit 3;"`
- `docker compose restart agent`, then ask Somnus to `cc.sh resume` the
  earlier session — the claude_state volume should keep it. (If resume fails,
  check `docker volume ls | grep claude_state`.)

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
