#!/usr/bin/env bash
set -euo pipefail

service_name="graycode_reader.service"
action="${1:-restart}"

case "$action" in
  start|stop|restart|status|enable|disable)
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|enable|disable}" >&2
    exit 1
    ;;
esac

if [[ "$action" == "enable" || "$action" == "disable" ]]; then
  sudo systemctl "$action" --now "$service_name"
else
  sudo systemctl "$action" "$service_name"
fi
