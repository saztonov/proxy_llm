#!/usr/bin/env bash
# Еженедельный WAL checkpoint для proxy_llm. Запускать под proxy_llm из cron.
# 30 3 * * 0 /opt/proxy_llm/scripts/wal-checkpoint.sh
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/proxy_llm/prod.db}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB not found: $DB_PATH" >&2
  exit 1
fi

sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"
echo "wal_checkpoint ok"
