#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
latest="$root/.codex_snapshots/latest.json"

if [ ! -f "$latest" ]; then
  echo "No snapshot found at $latest" >&2
  exit 1
fi

python3 - "$latest" <<'PY'
import json
import os
import shutil
import sys

latest = sys.argv[1]
root = os.path.abspath(os.path.dirname(latest))

with open(latest, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

files = payload.get("files", {})
if not files:
    print("No files recorded in latest snapshot.")
    sys.exit(0)

print("restored:")
for dest, src in files.items():
    if not os.path.isfile(src):
        print(f"missing snapshot source: {src}")
        continue
    dest_path = os.path.abspath(os.path.join(os.path.dirname(root), dest))
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    shutil.copy2(src, dest_path)
    print(f"{dest_path} <- {src}")
PY
