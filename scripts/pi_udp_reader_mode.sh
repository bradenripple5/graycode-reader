#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/native"
UI_DIR="$ROOT_DIR/3d arm simulation"
DIAGNOSTIC_READER_DIR="$UI_DIR/diagnostics/camera_reader"
HEADLESS_PID_FILE="/tmp/graycode_headless_reader.pid"
HEADLESS_LOG="/tmp/graycode_headless_reader.log"
FRONTEND_PID_FILE="/tmp/graycode_3d_arm_sim.pid"
FRONTEND_LOG="/tmp/graycode_3d_arm_sim.log"
BRIDGE_PID_FILE="/tmp/graycode_calibration_bridge.pid"
BRIDGE_LOG="/tmp/graycode_calibration_bridge.log"

detect_usb_cameras() {
  local link target
  local indices=()
  shopt -s nullglob
  for link in /dev/v4l/by-path/*usb*-video-index0; do
    target="$(readlink -f "$link" 2>/dev/null || true)"
    if [[ "$target" =~ /dev/video([0-9]+)$ ]]; then
      indices+=("${BASH_REMATCH[1]}")
    fi
  done
  shopt -u nullglob
  local IFS=,
  echo "${indices[*]}"
}

CAMERAS="${CAMERAS:-}"

ensure_cameras() {
  if [[ -n "$CAMERAS" ]]; then
    return
  fi
  CAMERAS="$(detect_usb_cameras)"
  if [[ -z "$CAMERAS" ]]; then
    echo "No USB camera capture devices found under /dev/v4l/by-path." >&2
    exit 1
  fi
}

WIDTH="${WIDTH:-640}"
HEIGHT="${HEIGHT:-480}"
FPS="${FPS:-30}"
PROCESS_FPS="${PROCESS_FPS:-10}"
DOWNSCALE="${DOWNSCALE:-320}"
UDP_PORT="${UDP_PORT:-5000}"
UDP_TARGET="${UDP_TARGET:-127.0.0.1:5010}"
BRIDGE_UDP_HOST="${BRIDGE_UDP_HOST:-127.0.0.1}"
BRIDGE_UDP_PORT="${BRIDGE_UDP_PORT:-5010}"
BRIDGE_HTTP_HOST="${BRIDGE_HTTP_HOST:-127.0.0.1}"
BRIDGE_HTTP_PORT="${BRIDGE_HTTP_PORT:-8091}"
NANO_SPECS="${NANO_SPECS:-}"
NANO_BAUD="${NANO_BAUD:-115200}"
UI_HOST="${UI_HOST:-0.0.0.0}"
UI_PORT="${UI_PORT:-5176}"
CAMERA_BROWSER_PORT="${CAMERA_BROWSER_PORT:-8092}"

if [[ -z "$NANO_SPECS" ]]; then
  SINGLE_NANO="/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0"
  DUAL_NANO="/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
  if [[ -e "$SINGLE_NANO" && -e "$DUAL_NANO" ]]; then
    NANO_SPECS="single@230400:$SINGLE_NANO dual@230400:$DUAL_NANO"
  fi
fi

if [[ -x "${CAMERA_READER_BIN:-}" ]]; then
  CAMERA_READER_BIN="$CAMERA_READER_BIN"
elif [[ -x "$DIAGNOSTIC_READER_DIR/basic_fiducial_reader" ]]; then
  CAMERA_READER_BIN="$DIAGNOSTIC_READER_DIR/basic_fiducial_reader"
else
  CAMERA_READER_BIN="$NATIVE_DIR/basic_fiducial_reader"
fi
CAMERA_READER_DIR="$(dirname "$CAMERA_READER_BIN")"

usage() {
  cat <<EOF
Usage: $0 {headless|visual|gui|frontend|stop|stop-all|status}

Commands:
  headless  Start frontend, then start basic_fiducial_reader headless.
  visual    Start frontend, then run basic_fiducial_reader with OpenCV windows and UDP.
  gui       Start frontend, then open native/udp_reader.py in the foreground.
  frontend  Restart only the 3D arm frontend.
  stop      Stop udp_reader.py and basic_fiducial_reader.
  stop-all  Stop reader processes and the 3D arm frontend.
  status    Show reader/bridge/frontend processes and recent headless log lines.

Environment overrides:
  CAMERAS=$CAMERAS
  WIDTH=$WIDTH
  HEIGHT=$HEIGHT
  FPS=$FPS
  PROCESS_FPS=$PROCESS_FPS
  DOWNSCALE=$DOWNSCALE
  UDP_PORT=$UDP_PORT
  UDP_TARGET=$UDP_TARGET
  BRIDGE_HTTP_PORT=$BRIDGE_HTTP_PORT
  NANO_SPECS=$NANO_SPECS
  NANO_BAUD=$NANO_BAUD
  UI_HOST=$UI_HOST
  UI_PORT=$UI_PORT
  CAMERA_BROWSER_PORT=$CAMERA_BROWSER_PORT

NANO_SPECS format:
  "sensors:/dev/ttyUSB0 feedback:/dev/ttyUSB1"
EOF
}

reader_supports_http_port() {
  "$CAMERA_READER_BIN" --help 2>&1 | grep -q -- "--http-port"
}

camera_reader_args() {
  local args=(
    --cameras "$CAMERAS"
    --width "$WIDTH"
    --height "$HEIGHT"
    --fps "$FPS"
    --process-fps "$PROCESS_FPS"
    --downscale "$DOWNSCALE"
    --udp-port "$UDP_PORT"
    --udp-target "$UDP_TARGET"
    --ring-fit
  )
  if [[ "$CAMERA_BROWSER_PORT" != "0" ]]; then
    if reader_supports_http_port; then
      args+=(--http-port "$CAMERA_BROWSER_PORT")
    else
      echo "Camera reader does not support --http-port; browser feeds disabled for $CAMERA_READER_BIN" >&2
    fi
  fi
  printf '%s\n' "${args[@]}"
}

DETACHED_PID=""
start_detached() {
  local log_file="$1"
  shift
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$@" > "$log_file" 2>&1 < /dev/null &
  else
    nohup "$@" > "$log_file" 2>&1 < /dev/null &
  fi
  DETACHED_PID=$!
}

kill_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

kill_matches() {
  local pattern="$1"
  local pid
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    [[ "$pid" == "$$" ]] && continue
    [[ "$pid" == "${PPID:-}" ]] && continue
    kill "$pid" 2>/dev/null || true
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

stop_readers() {
  kill_pid_file "$HEADLESS_PID_FILE"
  kill_matches "$NATIVE_DIR/udp_reader.py"
  kill_matches "python3? .*udp_reader.py"
  kill_matches "$NATIVE_DIR/basic_fiducial_reader"
  kill_matches "$DIAGNOSTIC_READER_DIR/basic_fiducial_reader"
  kill_matches "$CAMERA_READER_BIN"
  sleep 1
}

stop_bridge() {
  kill_pid_file "$BRIDGE_PID_FILE"
  kill_matches "$NATIVE_DIR/calibration_bridge.py"
  kill_matches "python3? .*calibration_bridge.py"
  sleep 1
}

stop_frontend() {
  kill_pid_file "$FRONTEND_PID_FILE"
  kill_matches "$UI_DIR/node_modules/.bin/vite --host $UI_HOST --port $UI_PORT"
  kill_matches "vite --host $UI_HOST --port $UI_PORT"
  sleep 1
}

start_frontend() {
  stop_frontend
  cd "$UI_DIR"
  start_detached "$FRONTEND_LOG" env \
    VITE_DEMO_NO_BACKEND=true \
    BCR_CALIBRATION_BRIDGE_URL="http://$BRIDGE_HTTP_HOST:$BRIDGE_HTTP_PORT" \
    BCR_CAMERA_BROWSER_PORT="$CAMERA_BROWSER_PORT" \
    node node_modules/vite/bin/vite.js \
    --host "$UI_HOST" \
    --port "$UI_PORT" \
    --strictPort
  echo "$DETACHED_PID" > "$FRONTEND_PID_FILE"
  echo "Started 3D arm frontend PID $(cat "$FRONTEND_PID_FILE")"
  echo "URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$UI_PORT/"
  echo "Log: $FRONTEND_LOG"
}

start_bridge() {
  stop_bridge
  cd "$ROOT_DIR"
  local cmd=(python3 native/calibration_bridge.py
    --udp-host "$BRIDGE_UDP_HOST"
    --udp-port "$BRIDGE_UDP_PORT"
    --http-host "$BRIDGE_HTTP_HOST"
    --http-port "$BRIDGE_HTTP_PORT"
    --nano-baud "$NANO_BAUD")
  local spec
  for spec in $NANO_SPECS; do
    cmd+=(--nano "$spec")
  done
  start_detached "$BRIDGE_LOG" "${cmd[@]}"
  echo "$DETACHED_PID" > "$BRIDGE_PID_FILE"
  echo "Started calibration bridge PID $(cat "$BRIDGE_PID_FILE")"
  echo "URL: http://$BRIDGE_HTTP_HOST:$BRIDGE_HTTP_PORT/api/calibration/status"
  echo "Log: $BRIDGE_LOG"
}

start_headless() {
  ensure_cameras
  start_frontend
  start_bridge
  stop_readers
  cd "$CAMERA_READER_DIR"
  mapfile -t reader_args < <(camera_reader_args)
  start_detached "$HEADLESS_LOG" "$CAMERA_READER_BIN" \
    "${reader_args[@]}" \
    --no-window
  echo "$DETACHED_PID" > "$HEADLESS_PID_FILE"
  echo "Started headless reader PID $(cat "$HEADLESS_PID_FILE")"
  if [[ "$CAMERA_BROWSER_PORT" != "0" ]]; then
    echo "Camera feed URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$CAMERA_BROWSER_PORT/camera/<index>.mjpg"
  fi
  echo "Log: $HEADLESS_LOG"
}

ensure_display() {
  if [[ -z "${DISPLAY:-}" && -S /tmp/.X11-unix/X1 ]]; then
    export DISPLAY=:1
  fi
}

start_visual() {
  ensure_cameras
  start_frontend
  start_bridge
  stop_readers
  ensure_display
  cd "$CAMERA_READER_DIR"
  echo "Starting visual reader with UDP target: $UDP_TARGET"
  echo "Display: ${DISPLAY:-unset}"
  mapfile -t reader_args < <(camera_reader_args)
  exec "$CAMERA_READER_BIN" "${reader_args[@]}"
}

start_gui() {
  start_frontend
  start_bridge
  stop_readers
  ensure_display
  cd "$NATIVE_DIR"
  echo "Starting UDP Reader GUI. Set Forward UDP target to: $UDP_TARGET"
  echo "Display: ${DISPLAY:-unset}"
  exec python3 udp_reader.py
}

show_status() {
  echo "--- processes ---"
  pgrep -af "udp_reader.py|basic_fiducial_reader|calibration_bridge.py|vite.*$UI_PORT" || true
  echo
  echo "--- headless log ---"
  tail -n 30 "$HEADLESS_LOG" 2>/dev/null || echo "No headless log at $HEADLESS_LOG"
  echo
  echo "--- frontend log ---"
  tail -n 20 "$FRONTEND_LOG" 2>/dev/null || echo "No frontend log at $FRONTEND_LOG"
  echo
  echo "--- calibration bridge log ---"
  tail -n 20 "$BRIDGE_LOG" 2>/dev/null || echo "No calibration bridge log at $BRIDGE_LOG"
  echo
  echo "--- calibration status ---"
  curl -s http://127.0.0.1:5176/api/calibration/status 2>/dev/null || true
  echo
}

case "${1:-}" in
  headless)
    start_headless
    show_status
    ;;
  visual)
    start_visual
    ;;
  gui)
    start_gui
    ;;
  frontend)
    start_frontend
    show_status
    ;;
  stop)
    stop_readers
    show_status
    ;;
  stop-all)
    stop_readers
    stop_bridge
    stop_frontend
    show_status
    ;;
  status)
    show_status
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
