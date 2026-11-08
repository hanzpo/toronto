#!/usr/bin/env bash
# app/qa/bench/shots.sh <outdir> <layout[:cam]>...   cam = x,y,dist,headingDeg,pitchDeg
set -euo pipefail
OUT="$1"; shift
BASE="${BENCH_URL:-http://localhost:5199}"
PW="npx -y @playwright/cli -s=bench"
mkdir -p "$OUT"
trap '$PW close >/dev/null 2>&1 || true' EXIT
$PW open --browser=chrome about:blank >/dev/null
$PW resize "${BENCH_W:-1280}" "${BENCH_H:-800}" >/dev/null
for spec in "$@"; do
  id="${spec%%:*}"; cam=""; name="$id"
  if [[ "$spec" == *:* ]]; then cam="&cam=${spec#*:}"; name="${id}_$(echo "${spec#*:}" | tr ',' '_')"; fi
  $PW goto "$BASE/bench.html?l=$id&ui=${BENCH_UI:-0}$cam" >/dev/null
  for i in $(seq 1 40); do
    r=$($PW eval "window.__bench ? window.__bench.frames() : 0" 2>/dev/null | grep -Eo '^[0-9]+' | head -1 || echo 0)
    [ "${r:-0}" -gt 20 ] && break
    sleep 0.5
  done
  sleep 1.5
  $PW screenshot --filename="$OUT/$name.png" >/dev/null
  echo "$OUT/$name.png"
done
$PW console error 2>/dev/null | tail -5 || true
