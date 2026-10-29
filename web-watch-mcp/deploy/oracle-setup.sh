#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run as root\n' >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/job-crawler}"

apt-get update
apt-get install -y docker.io docker-compose-v2 ufw
systemctl enable --now docker

install -d -m 700 -o 1000 -g 1000 "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
