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
