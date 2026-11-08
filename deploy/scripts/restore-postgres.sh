#!/usr/bin/env sh
set -eu

# Restores a gzip-compressed pg_dump into the Compose postgres service.
# WARNING: destructive. Confirm before running against production data.
# Usage (from deploy/):
#   ./scripts/restore-postgres.sh /path/to/kern-postgres-YYYYMMDD.sql.gz

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 1
fi

BACKUP=$1
ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$ROOT_DIR/docker-compose.yml"}
SERVICE=${POSTGRES_SERVICE:-postgres}

if [ ! -f "$BACKUP" ]; then
  echo "Backup file not found: $BACKUP" >&2
  exit 1
fi

echo "Restoring $BACKUP into Compose service '$SERVICE'"
gzip -dc "$BACKUP" | docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'

echo "Restore complete."
