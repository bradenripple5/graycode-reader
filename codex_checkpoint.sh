#!/usr/bin/env bash
set -euo pipefail

desc="${1:-}"
summary=""
shift

if [ "${1:-}" = "--summary" ]; then
  summary="${2:-}"
  shift 2
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 \"desc\" [--summary \"text\"] <file>..." >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ts="$(date +%Y%m%d_%H%M%S)"
snap_dir="$root/.codex_snapshots/$ts"

mkdir -p "$snap_dir"

for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "warning: skip missing file $f" >&2
    continue
  fi
  dest="$snap_dir/$f"
  mkdir -p "$(dirname "$dest")"
  cp -p "$f" "$dest"
done

if [ -n "$summary" ]; then
  printf "%s\n" "$summary" > "$snap_dir/summary.txt"
fi

python3 - "$snap_dir" "$desc" "$@" <<'PY'
import json
import os
import sys

snap_dir, desc, *files = sys.argv[1:]
root = os.path.abspath(os.path.dirname(__file__))

mapping = {}
for f in files:
    if not os.path.isfile(f):
        continue
    mapping[f] = os.path.join(snap_dir, f)

latest_path = os.path.join(root, ".codex_snapshots", "latest.json")
payload = {
    "timestamp": os.path.basename(snap_dir),
    "description": desc,
    "files": mapping,
}
with open(latest_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)

print("snapshotted:")
for src, dst in mapping.items():
    print(f"{src} -> {dst}")
PY
