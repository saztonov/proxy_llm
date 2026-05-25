#!/usr/bin/env bash
# Бэкап SQLite БД proxy_llm. Запускается под пользователем proxy_llm из cron.
# 0 3 * * * /opt/proxy_llm/scripts/backup-db.sh
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/proxy_llm/prod.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/proxy_llm/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/prod.db.${ts}"

# Atomic backup через .backup. Безопасно для work-in-flight в WAL-mode.
sqlite3 "$DB_PATH" ".backup '$out'"
gzip "$out"

# Очистить старые бэкапы
find "$BACKUP_DIR" -maxdepth 1 -name 'prod.db.*.gz' -mtime "+${RETENTION_DAYS}" -delete

echo "backup ok: ${out}.gz"
