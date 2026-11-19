#!/usr/bin/env bash
# Package the working data for upload to the owner's Google Drive ("yellowbook data" folder).
# Writes data/snapshot/: the database (xz), the usable-contacts CSV the owner works from, and a
# manifest of sha256 hashes. Nothing here is
# uploaded by this script: a Claude session uploads the files with the Drive connector.
# See HANDOFF.md, "Data on Google Drive".
set -euo pipefail
cd "$(dirname "$0")/.."
out=data/snapshot
day=$(date -u +%Y-%m-%d)
mkdir -p "$out"
rm -f "$out"/*

# Fold the WAL into the main file so the copy is complete.
node -e "const D=require('better-sqlite3');const d=new D('data/yellowbook.sqlite');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"
# xz: about 40% smaller than gzip; keeps the database under the Drive connector limit. Restore: xz -d.
xz -9e -c data/yellowbook.sqlite > "$out/yellowbook.sqlite.xz"
# Raw API responses are not backed up (owner decision, 2026-11-19).
# The list the owner uses: only contacts whose email is verified or probably fine.
npx tsx cli/yb.ts export "$out/yellowbook_usable_$day.csv" --usable >/dev/null

(cd "$out" && sha256sum * > MANIFEST.sha256)
limit=$((3100 * 1024))
for f in "$out"/*; do
  size=$(stat -c %s "$f")
  if [ "$size" -gt "$limit" ]; then echo "WARNING: $f is $size bytes, over the connector's ~3.1 MB per-call limit; split it before upload." >&2; fi
done
ls -la "$out"
