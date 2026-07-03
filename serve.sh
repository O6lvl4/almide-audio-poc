#!/usr/bin/env bash
# Serve host/ on localhost so the browser can load the worklet module.
# AudioWorklet requires HTTPS or localhost (file:// won't work).
#
# No COOP/COEP headers needed — this PoC does not use SharedArrayBuffer.

set -euo pipefail
cd "$(dirname "$0")"/host

port="${1:-8765}"
echo "Serving http://localhost:$port/"
python3 -m http.server "$port"
