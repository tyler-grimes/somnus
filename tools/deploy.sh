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
