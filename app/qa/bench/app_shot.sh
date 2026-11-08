#!/usr/bin/env bash
# app/qa/bench/app_shot.sh <out.png> <query>   screenshot of the main app after tiles settle
set -euo pipefail
OUT="$1"; Q="$2"
BASE="${BENCH_URL:-http://localhost:5199}"
PW="npx -y @playwright/cli -s=app"
trap '$PW close >/dev/null 2>&1 || true' EXIT
$PW open --browser=chrome about:blank >/dev/null
$PW resize 1280 800 >/dev/null
$PW goto "$BASE/?$Q" >/dev/null
sleep "${WAIT:-25}"
$PW screenshot --filename="$OUT" >/dev/null
$PW console error 2>/dev/null | grep -v favicon | tail -8 || true
echo "$OUT"
