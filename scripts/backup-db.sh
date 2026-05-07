#!/usr/bin/env bash
# Daily backup of gs_graphics_db to ~/backups/gs-graphics/.
# Keeps the most recent 30 days; older files removed.
set -euo pipefail

BACKUP_DIR="$HOME/backups/gs-graphics"
RETENTION_DAYS=30
TIMESTAMP="$(date +%Y-%m-%d_%H%M%S)"
OUTFILE="$BACKUP_DIR/gs_graphics_db_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Dump from inside the postgres container, then gzip on the host.
docker exec gs-graphics-db pg_dump -U gs_graphics_user -d gs_graphics_db \
  | gzip -9 > "$OUTFILE"

# Refuse to keep an empty file on disk
if [ ! -s "$OUTFILE" ]; then
  echo "ERROR: backup is empty, removing and exiting non-zero" >&2
  rm -f "$OUTFILE"
  exit 1
fi

# Rotation
find "$BACKUP_DIR" -maxdepth 1 -name 'gs_graphics_db_*.sql.gz' -type f \
  -mtime +"$RETENTION_DAYS" -delete

# Symlink to latest for quick access
ln -sf "$OUTFILE" "$BACKUP_DIR/latest.sql.gz"

echo "Backup OK: $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"
