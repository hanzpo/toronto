#!/usr/bin/env bash
# Frame-time benchmarks against the dev server or the deployed site.
#
#   app/perf/run.sh [base-url] [scenarios] [extra-query]
#     base-url   default http://localhost:5173  (e.g. https://toronto.hanznathanpo.workers.dev)
#     scenarios  comma list: street,streetcar,dvp,region,city,zoom,pan (default: all),
#                or "startup" (cold + warm load timing) or "diag" (scene breakdown, extra "cam=E,N,dist,hdg,pitch")
#     extra      extra query string (default "quality=high": pins the governor for comparable runs)
#
# Uses ONE headless Chrome session (named "perf") and closes it when done.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${1:-http://localhost:5173}"
SCEN="${2:-street,streetcar,dvp,region,zoom,pan}"
EXTRA="${3:-quality=high}"
PW="npx -y @playwright/cli -s=perf"
trap '$PW close >/dev/null 2>&1 || true' EXIT
$PW open --browser=chrome about:blank >/dev/null
$PW resize 1600 1000 >/dev/null
case "$SCEN" in
  startup|diag|draws|shots) FILE="$HERE/$SCEN.js" ;;
  *) FILE="$HERE/bench.js" ;;
esac
$PW goto "$BASE/?bench=$SCEN${EXTRA:+&$EXTRA}" >/dev/null
# print only the returned JSON
$PW run-code --filename="$FILE" | awk '/^### Result/{f=1;next} /^### /{f=0} f' | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.trim();try{let v=JSON.parse(s);if(typeof v==="string")v=JSON.parse(v);
if(Array.isArray(v))for(const r of v)console.log(JSON.stringify(r));else console.log(JSON.stringify(v,null,1));}catch{console.log(s)}})'

