#!/usr/bin/env sh
set -eu

# Creates a gzip-compressed PostgreSQL logical backup from the Compose postgres service.
# Usage (from deploy/):
#   ./scripts/backup-postgres.sh [output-dir]

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/backups"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUTPUT_DIR/kern-postgres-$STAMP.sql.gz"

mkdir -p "$OUTPUT_DIR"

COMPOSE_FILE=${COMPOSE_FILE:-"$ROOT_DIR/docker-compose.yml"}
SERVICE=${POSTGRES_SERVICE:-postgres}

echo "Writing backup to $FILE"
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE" \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  | gzip -c > "$FILE"

echo "Backup complete: $FILE"
echo "Recommended retention: keep daily backups for 7 days and weekly backups for 4 weeks."
