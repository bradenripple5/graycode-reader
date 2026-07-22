# 3D Arm Simulation

Browser-based BCR arm visualization copied from `bcr_arm/browser_ui`.

## Run

```bash
npm install
VITE_DEMO_NO_BACKEND=true npm run dev -- --host 127.0.0.1 --port 5176
```

Open `http://127.0.0.1:5176/`.

Robot-backend status is polled every 3 seconds by default. Override the interval
for a development launch with `--status-poll-ms`, or set
`VITE_STATUS_POLL_INTERVAL_MS` directly:

```bash
npm run dev -- --status-poll-ms 5000 --host 127.0.0.1 --port 5176
```

`npm run dev` checks `http://127.0.0.1:8091/api/calibration/status` before
starting Vite. If it is unavailable, it starts the local calibration bridge,
then discovers camera 0's USB capture node from sysfs when live readings are
absent. Camera `0` directly supplies the base joint angle; USB hub-port labels
are not used for camera-to-joint assignment.
The browser can still launch when another joint sensor is unavailable. Set
`BCR_CALIBRATION_BRIDGE_URL` to use an
already-running bridge elsewhere; the dev command will verify that remote
endpoint but will not attempt to start it. Optional serial sources can be
passed with `BCR_CALIBRATION_NANO_SPECS`, for example
`BCR_CALIBRATION_NANO_SPECS="single@230400:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0,dual@230400:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"`.
Use `BCR_CALIBRATION_CAMERAS` to override the detected camera list.
The default local configuration already uses those two Nano serial streams.
It addresses them by stable `/dev/serial/by-id` paths so reconnecting the
boards cannot swap the single-MPU FTDI board and dual-MPU CH340 board when
`/dev/ttyUSB0` and `/dev/ttyUSB1` are reassigned. Each calibration stream
event includes their raw parsed packets in the `accelerometers` field.

To show the camera 0 window while starting the same stack, add:

```bash
npm run dev -- --visualize-with-camera-gui --host 0.0.0.0 --port 5177
```

This replaces a running headless fiducial reader with the visual camera reader.
The camera 0 view is a native OpenCV window, not browser content. By default
it opens on the local TigerVNC display `:1`; use
`BCR_CAMERA_GUI_DISPLAY=:0` before the command to place it on the physical
desktop instead. The camera view is windowed by default so it does not fill the
Pi VNC desktop. Add `--maximize-camera-gui` to the development command when a
maximized view is preferred.

Browser camera video is intentionally unavailable. The native reader still
processes camera frames for joint-angle calibration and reports numeric camera
status to the UI, but it does not JPEG-encode or stream those frames over HTTP.
Each visible ArUco code independently estimates the wheel's upward angle from
its decoded corner orientation and fixed ID position. The reported camera angle
is the area-weighted circular average of those estimates; matching inner/outer
code pairs are no longer required. The default pattern has 19 positions; set
`BCR_CALIBRATION_RING_POSITIONS` when using a differently configured print.
Across frames, camera 0's base-joint estimate preserves the camera's `0–360°`
values and uses the ordinary arithmetic mean (`sum / count`) over its recent
readings. The other joints retain circular averaging.

To drive shoulder and elbow from the dual-MPU Arduino and wrist from the
single-MPU Arduino, start the calibration bridge at 230400 baud. In the
current hardware layout, the FTDI board is the single MPU and the CH340 board
is the dual MPU:

```bash
cd /home/pi/graycode_reader
python3 native/calibration_bridge.py \
  --http-host 127.0.0.1 \
  --http-port 8091 \
  --nano single@230400:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0 \
  --nano dual@230400:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0
```

`VITE_DEMO_NO_BACKEND=true` only suppresses the ROS robot-control backend
calls for `/api/status`, `/api/joints`, and `/api/pose`. Calibration still uses
the real Python backend below.

## Calibration Backend

The browser cannot read UDP directly. Run the Python calibration backend to
convert forwarded graycode UDP JSON into HTTP endpoints for the UI:

```bash
cd /home/pi/graycode_reader
python3 native/calibration_bridge.py --udp-host 127.0.0.1 --udp-port 5010 --http-host 127.0.0.1 --http-port 8091
```

In the UDP Reader GUI, set:

```text
Forward UDP target: 127.0.0.1:5010
```

To include Nano serial data in the same calibration status endpoint, pass one
or more `--nano name:/dev/tty...` options:

```bash
python3 native/calibration_bridge.py \
  --udp-host 127.0.0.1 \
  --udp-port 5010 \
  --http-host 127.0.0.1 \
  --http-port 8091 \
  --nano sensors:/dev/ttyUSB0 \
  --nano feedback:/dev/ttyUSB1
```

The launcher script can pass the same serial inputs through `NANO_SPECS`:

```bash
NANO_SPECS="sensors:/dev/ttyUSB0 feedback:/dev/ttyUSB1" \
  ./scripts/pi_udp_reader_mode.sh headless
```

The browser UI calls the backend through Vite's `/api/calibration/...` proxy.
Each live accelerometer row shows circular angle averages over its latest 10
and 100 valid samples. The shorter average reacts faster, while the 100-sample
average makes longer-term noise and drift easier to see.

The accelerometer angle used for arm control is estimated from a time-aware
least-squares line over the newest 10 readings (after at least five arrive),
then passed into the existing gyro/complementary filter. At a 1 ms reading
interval this uses only 10 ms of history. Override the defaults with
`--accel-polynomial-window` and `--accel-polynomial-degree` (or the
`BCR_ACCEL_POLYNOMIAL_WINDOW` and `BCR_ACCEL_POLYNOMIAL_DEGREE` environment
variables); for example, use a 20-reading window when lower resting noise
matters more than response:

```bash
npm run dev -- --accel-polynomial-window 20 --host 0.0.0.0 --port 5176
```

During pre-calibration, move the model to a collision-free pose and press
**Record Current Pose** to add a row. Each row stores the model target angles
and live sensor readings (including the last-10 averages) at capture time.
Moving the model alone never adds a calibration row. The mapped joint targets
are:

```text
base=0, shoulder=90, elbow=0, wrist=90
```

Selecting **Complete Calibration** fits a separate linear sensor-to-model-angle
mapping for each joint from all recorded poses. Incoming sensor readings then
drive those calibrated joint angles, which the 3D arm uses to calculate its
live pose. Completing calibration also locks out preset, custom-joint, direct,
sequence, and backend-sync movement so calibrated sensors remain the only arm
motion source. Select **Unlock & Recalibrate** to restore manual controls and
start a new calibration session. A joint without any recorded sensor samples
does not prevent completion; it remains fixed at the final recorded pose while
the available sensor-driven joints continue to move.

Browser reloads preserve calibration rows held by the bridge, so refreshing the
page or receiving a Vite development update does not erase a recording session.
Saved rows are not automatically loaded into the active fit. Check
**Load / reload** beside each row to include it and remember that selection for
future browser refreshes. **Clear Loaded Readings** unloads every row without
deleting the saved recordings. The selected rows remain in pre-calibration mode
until **Complete Calibration** is selected again.

If Chrome cannot create a WebGL context over VNC/remote X11, start Chrome with software WebGL enabled:

```bash
google-chrome-stable \
  --user-data-dir=/tmp/bcr_arm_chrome_webgl \
  --no-first-run \
  --no-default-browser-check \
  --ignore-gpu-blocklist \
  --enable-webgl \
  --enable-unsafe-swiftshader \
  --use-gl=angle \
  --use-angle=swiftshader \
  http://127.0.0.1:5176/
```
