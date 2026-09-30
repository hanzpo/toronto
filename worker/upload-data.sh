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
# retry transient network failures (one failed pack used to abort the whole deploy)
put() {
  for i in 1 2 3 4; do
    npx wrangler r2 object put "toronto-data/$1" --file "$2" --remote >/dev/null 2>&1 && { echo "  $1"; return 0; }
    sleep $((i * 5))
  done
  echo "  FAILED $1" >&2; return 1
}
export -f put
{
  [ $PACKS_TOO = 1 ] && for f in "$PACKS"/*; do echo "packs/$(basename "$f") $f"; done
  (cd "$DATA" && find . -type f ! -path './tiles/*' ! -path './graph/*' | sed 's|^\./||') | while read -r rel; do echo "data/$rel $DATA/$rel"; done
} | xargs -P 8 -L 1 bash -c 'put "$0" "$1"'
