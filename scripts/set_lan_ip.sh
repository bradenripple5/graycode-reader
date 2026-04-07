#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$ROOT_DIR/rotating_marker.html"

if [[ ! -f "$FILE" ]]; then
  echo "Missing file: $FILE" >&2
  exit 1
fi

extract_ip() {
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | sed -nE 's/.*inet (10\.[0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n1 || true
    return 0
  fi
  return 1
}

IP="${1:-}"
if [[ -z "$IP" ]]; then
  IP="$(extract_ip || true)"
fi
if [[ -z "$IP" ]]; then
  if command -v ip >/dev/null 2>&1; then
    IP="$(ip -4 addr 2>/dev/null | sed -nE 's/.*inet (10\.[0-9]+\.[0-9]+\.[0-9]+)\/.*/\1/p' | head -n1 || true)"
  fi
fi

if [[ -z "$IP" ]]; then
  echo "Could not detect a 10.x.x.x address. Pass one explicitly:" >&2
  echo "  ./scripts/set_lan_ip.sh 10.0.0.88" >&2
  exit 1
fi

if ! [[ "$IP" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing non-10.x.x.x IP: $IP" >&2
  exit 1
fi

sed -i -E "s/const LAN_IP_OVERRIDE = '[^']*';/const LAN_IP_OVERRIDE = '$IP';/" "$FILE"

echo "Set LAN_IP_OVERRIDE to $IP in rotating_marker.html"
