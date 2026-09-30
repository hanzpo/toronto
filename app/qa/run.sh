#!/usr/bin/env bash
# Visual QA against the dev server (or the deployed site).
#
#   app/qa/run.sh tour  [base-url] [topK=5] [categories=all] [label=latest]
#       top-K issues per category from data/qa/issues.json -> qa-shots/<label>/<cat>/<rank>_<E>_<N>.png
#       + manifest.json + index.html (contact sheet). categories: comma list or "all".
#   app/qa/run.sh sweep [base-url] [label=latest] [batch=50] [tag-prefix] [limit]
#       deterministic viewpoint sweep from data/qa/viewpoints.json -> qa-shots/sweep/<label>/<tag>/<id>.png
#       + manifest.jsonl + index.html. Resumable: ids whose PNG exists are skipped.
#   app/qa/run.sh sheet <dir>        rebuild the contact sheet for a tour or sweep folder
#
# env: QA_ISSUES=issues.json / QA_VIEWPOINTS=viewpoints.json (file names under app/public/data/qa/)
#      QA_TIME=46800 (sim time of day, s; fixed for reproducible light)   QA_EXTRA=quality=high
#      QA_TOUR_BATCH=25
#
# Uses ONE headless Chrome session (named "qa"); every batch opens it and closes it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DATA="$ROOT/app/public/data/qa"
MODE="${1:-tour}"
PW="npx -y @playwright/cli -s=qa"
QA_TIME="${QA_TIME:-46800}"
EXTRA="${QA_EXTRA:-quality=high}"
trap '$PW close >/dev/null 2>&1 || true' EXIT

lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

# run one batch: <base> <job.json> <script.js> <results.jsonl>
batch() {
  local base="$1" job="$2" script="$3" res="$4"
  $PW open --browser=chrome about:blank >/dev/null
  $PW resize 1280 720 >/dev/null
  $PW goto "$base/?stats=0${EXTRA:+&$EXTRA}" >/dev/null
  $PW localstorage-set qa_job "$(cat "$job")" >/dev/null
  $PW run-code --filename="$script" | awk '/^### Result/{f=1;next} /^### /{f=0} f' | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.trim();try{let v=JSON.parse(s);if(typeof v==="string")v=JSON.parse(v);
for(const r of v)console.log(JSON.stringify(r));}catch{console.error("batch failed: "+s.slice(0,400))}})' >> "$res"
  $PW close >/dev/null 2>&1 || true
}

case "$MODE" in
tour)
  BASE="${2:-http://localhost:5173}"; TOPK="${3:-5}"; CATS="${4:-all}"; LABEL="${5:-latest}"
  FILE="${QA_ISSUES:-issues.json}"; [ -f "$DATA/$FILE" ] || FILE="issues.sample.json"
  OUT="$ROOT/qa-shots/$LABEL"; mkdir -p "$OUT"
  BATCH="${QA_TOUR_BATCH:-25}"
  # selection (skip already-shot files) -> job files
  NJOBS=$(node -e '
const fs=require("fs");const [src,out,topk,cats,batch,t,file]=process.argv.slice(1);
const d=JSON.parse(fs.readFileSync(src,"utf8"));const want=cats==="all"?null:new Set(cats.split(","));
const sel=d.issues.filter(i=>(!want||want.has(i.cat))&&i.rank<=+topk).map(i=>({...i,file:`${i.cat}/${i.rank}_${Math.round(i.e)}_${Math.round(i.n)}.png`}));
fs.writeFileSync(out+"/selection.json",JSON.stringify({source:file,build:d.build,generated:d.generated,items:sel}));
const todo=sel.filter(i=>!fs.existsSync(out+"/"+i.file));let k=0;
for(let s=0;s<todo.length;s+=+batch){fs.writeFileSync(out+`/.job${k++}.json`,JSON.stringify({dir:out,time:+t,issuesFile:file,items:todo.slice(s,s+ +batch).map(i=>({id:i.id,file:i.file}))}));}
console.log(k);' "$DATA/$FILE" "$OUT" "$TOPK" "$CATS" "$BATCH" "$QA_TIME" "$FILE")
  echo "tour: $FILE -> $OUT ($NJOBS batches)"
  T0=$(date +%s)
  for ((k = 0; k < NJOBS; k++)); do
    batch "$BASE" "$OUT/.job$k.json" "$HERE/tour.js" "$OUT/results.jsonl"
    rm -f "$OUT/.job$k.json"
  done
  node -e '
const fs=require("fs");const out=process.argv[1];const sel=JSON.parse(fs.readFileSync(out+"/selection.json","utf8"));
const res={};if(fs.existsSync(out+"/results.jsonl"))for(const l of fs.readFileSync(out+"/results.jsonl","utf8").split("\n"))if(l.trim()){const r=JSON.parse(l);res[r.id]=r;}
const items=sel.items.map(i=>({...i,shot:fs.existsSync(out+"/"+i.file),run:res[i.id]||null}));
fs.writeFileSync(out+"/manifest.json",JSON.stringify({kind:"tour",label:out.split("/").pop(),source:sel.source,build:sel.build,generated:new Date().toISOString(),items},null,1));' "$OUT"
  node "$HERE/sheet.mjs" "$OUT"
  echo "done in $(( $(date +%s) - T0 )) s: $OUT/index.html"
  ;;
sweep)
  BASE="${2:-http://localhost:5173}"; LABEL="${3:-latest}"; BATCH="${4:-50}"; PREFIX="${5:-}"; LIMIT="${6:-0}"
  FILE="${QA_VIEWPOINTS:-viewpoints.json}"; [ -f "$DATA/$FILE" ] || FILE="viewpoints.sample.json"
  OUT="$ROOT/qa-shots/sweep/$LABEL"; mkdir -p "$OUT"
  NJOBS=$(node -e '
const fs=require("fs");const [src,out,batch,prefix,limit,t,file]=process.argv.slice(1);
const d=JSON.parse(fs.readFileSync(src,"utf8"));
let vp=d.viewpoints.filter(v=>!prefix||v.tag.startsWith(prefix)||v.id.startsWith(prefix));
if(+limit>0)vp=vp.slice(0,+limit);
fs.writeFileSync(out+"/source.json",JSON.stringify({source:file,seed:d.seed,build:d.build,count:vp.length}));
const todo=vp.filter(v=>!fs.existsSync(`${out}/${v.tag}/${v.id}.png`));let k=0;
for(let s=0;s<todo.length;s+=+batch){fs.writeFileSync(out+`/.job${k++}.json`,JSON.stringify({dir:out,time:+t,items:todo.slice(s,s+ +batch).map(v=>({id:v.id,tag:v.tag,note:v.note,file:`${v.tag}/${v.id}.png`,pose:{e:v.e,n:v.n,h:v.h,dist:v.dist,heading:v.heading,pitch:v.pitch}}))}));}
console.error(`sweep: ${vp.length} viewpoints, ${todo.length} to shoot`);console.log(k);' "$DATA/$FILE" "$OUT" "$BATCH" "$PREFIX" "$LIMIT" "$QA_TIME" "$FILE")
  echo "sweep: $FILE -> $OUT ($NJOBS batches of <= $BATCH)"
  T0=$(date +%s); N0=$(lines "$OUT/manifest.jsonl")
  for ((k = 0; k < NJOBS; k++)); do
    TB=$(date +%s)
    batch "$BASE" "$OUT/.job$k.json" "$HERE/sweep.js" "$OUT/manifest.jsonl"
    rm -f "$OUT/.job$k.json"
    echo "  batch $((k + 1))/$NJOBS: $(( $(date +%s) - TB )) s"
  done
  N1=$(lines "$OUT/manifest.jsonl")
  node "$HERE/sheet.mjs" "$OUT"
  DT=$(( $(date +%s) - T0 )); SHOTS=$(( N1 - N0 ))
  if [ "$SHOTS" -gt 0 ]; then echo "done: $SHOTS shots in $DT s ($(( DT * 100 / SHOTS )) s per 100 shots incl. browser start-up) -> $OUT/index.html"
  else echo "nothing to shoot (all captured) -> $OUT/index.html"; fi
  ;;
sheet)
  node "$HERE/sheet.mjs" "${2:?dir}"
  ;;
*) echo "usage: $0 tour|sweep|sheet ..." >&2; exit 2 ;;
esac
