#!/usr/bin/env bash
# Run this with: bash run_camera_gui.sh
# Override any setting with an environment variable, e.g. CAMERAS=0 DISPLAY=:0.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
camera_list="${CAMERAS:-}"
if [[ -z "${camera_list}" ]]; then
  for index_file in /sys/class/video4linux/video*/index; do
    [[ -f "${index_file}" ]] || continue
    [[ "$(<"${index_file}")" == "0" ]] || continue
    video_dir="$(dirname -- "${index_file}")"
    device_path="$(realpath -- "${video_dir}/device")"
    [[ "${device_path}" == *"/usb"* ]] || continue
    video_name="$(basename -- "${video_dir}")"
    video_index="${video_name#video}"
    camera_list+="${camera_list:+,}${video_index}"
  done
fi
camera_list="${camera_list:-0}"
exec "${script_dir}/basic_fiducial_reader" \
  --cameras "${camera_list}" \
  --width "${WIDTH:-640}" \
  --height "${HEIGHT:-480}" \
  --fps "${FPS:-30}" \
  --process-fps "${PROCESS_FPS:-10}" \
  --downscale "${DOWNSCALE:-320}" \
  --udp-port "${UDP_PORT:-5000}" \
  --udp-target "${UDP_TARGET:-127.0.0.1:5010}" \
  --ring-positions "${RING_POSITIONS:-19}"
