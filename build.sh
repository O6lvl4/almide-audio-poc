#!/usr/bin/env bash
# Build Almide source to WASM.
#
# Requires `almide` >= 0.13 on PATH.
# Build the compiler first with `cd ../almide && make install`.

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v almide >/dev/null 2>&1; then
  echo "error: almide not on PATH." >&2
  echo "  cd ../almide && make install" >&2
  exit 1
fi

almide build src/main.almd --target wasm -o host/synth.wasm

size=$(wc -c < host/synth.wasm | tr -d ' ')
printf "\nBuilt: host/synth.wasm (%s bytes)\n" "$size"
