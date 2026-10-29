#!/bin/sh
set -eu

data_path="${DATA_DIR:-/app/data}"
mkdir -p "$data_path"

if [ "$(id -u)" = "0" ]; then
  # A newly attached persistent disk can be root-owned. Only change the mount
  # directory itself, never walk an existing browser profile on every restart.
  chown node:node "$data_path"
  exec gosu node "$@"
fi

exec "$@"
