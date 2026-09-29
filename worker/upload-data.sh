#!/usr/bin/env bash
# Upload the built dataset to R2 (bucket toronto-data): tile packs + every
# non-tile file under app/public/data (manifest, transit, landmarks).
# Usage: ./upload-data.sh [--no-packs]
set -euo pipefail
cd "$(dirname "$0")"
PACKS_TOO=1; [ "${1:-}" = "--no-packs" ] && PACKS_TOO=0
DATA=../app/public/data
PACKS=../pipeline/work/packs
[ $PACKS_TOO = 1 ] && (cd ../pipeline && uv run python -m tpipe.pack)
put() { npx wrangler r2 object put "toronto-data/$1" --file "$2" --remote >/dev/null && echo "  $1"; }
export -f put
{
  [ $PACKS_TOO = 1 ] && for f in "$PACKS"/*; do echo "packs/$(basename "$f") $f"; done
  (cd "$DATA" && find . -type f ! -path './tiles/*' | sed 's|^\./||') | while read -r rel; do echo "data/$rel $DATA/$rel"; done
} | xargs -P 8 -L 1 bash -c 'put "$0" "$1"'
