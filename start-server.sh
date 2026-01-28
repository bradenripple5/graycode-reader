#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")" && pwd)"

python3 "$root_dir/server.py" \
  --root "$root_dir" \
  --host 0.0.0.0 \
  --port 8001 \
  --https \
  --cert "$root_dir/10.0.0.87+3.pem" \
  --key "$root_dir/10.0.0.87+3-key.pem" \
  "$@"
