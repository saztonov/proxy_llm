#!/usr/bin/env bash
# Ротация логов журналируется через journald — этот скрипт зачищает только локальные
# логи приложения, если они когда-нибудь появятся в /var/lib/proxy_llm/.
# 0 4 * * 0 /opt/proxy_llm/scripts/rotate-logs.sh
set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/lib/proxy_llm/logs}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [[ -d "$LOG_DIR" ]]; then
  find "$LOG_DIR" -maxdepth 1 -name '*.log*' -mtime "+${RETENTION_DAYS}" -delete
  echo "log rotation ok"
else
  echo "no local log dir ($LOG_DIR) — nothing to do"
fi
