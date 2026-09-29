#!/usr/bin/env bash
# Build the app and deploy it to Cloudflare. Pass --data to also re-upload the
# dataset (tile/graph packs + transit/landmarks/manifest) to R2 first.
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--data" ]; then ./worker/upload-data.sh; fi
(cd app && pnpm build)
(cd worker && npx wrangler deploy)
