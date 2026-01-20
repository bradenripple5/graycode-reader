#!/usr/bin/env bash
set -euo pipefail

ip="${1:-}"
days="${2:-365}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found in PATH" >&2
  exit 1
fi

if [ -z "$ip" ]; then
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
fi

if [ -z "$ip" ]; then
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

if [ -z "$ip" ]; then
  echo "Could not detect local IP. Pass it explicitly, e.g.: ./make-certs.sh 10.0.0.87" >&2
  exit 1
fi

ca_key="ca.key"
ca_crt="ca.crt"
server_key="server.key"
server_csr="server.csr"
server_crt="server.crt"
san_ext="san.ext"

openssl req -x509 -new -nodes -newkey rsa:2048 \
  -keyout "$ca_key" -out "$ca_crt" -days "$days" \
  -subj "/CN=Local Dev CA"

openssl req -new -nodes -newkey rsa:2048 \
  -keyout "$server_key" -out "$server_csr" \
  -subj "/CN=$ip"

printf "subjectAltName=IP:%s\n" "$ip" > "$san_ext"

openssl x509 -req -in "$server_csr" \
  -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
  -out "$server_crt" -days "$days" -sha256 -extfile "$san_ext"

echo "Created:"
echo "  $ca_crt (install on phone as CA)"
echo "  $server_crt / $server_key (use with server.py)"
