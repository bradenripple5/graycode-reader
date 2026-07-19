# 3D Arm Simulation

Browser-based BCR arm visualization copied from `bcr_arm/browser_ui`.

## Run

```bash
npm install
VITE_DEMO_NO_BACKEND=true npm run dev -- --host 127.0.0.1 --port 5176
```

Open `http://127.0.0.1:5176/`.

`npm run dev` checks `http://127.0.0.1:8091/api/calibration/status` before
starting Vite. If it is unavailable, it starts the local calibration bridge,
then starts the four-camera reader (`0,2,4,7`) when live readings are absent.
It waits for all four joint readings before Vite launches. Set
`BCR_CALIBRATION_BRIDGE_URL` to use an
already-running bridge elsewhere; the dev command will verify that remote
endpoint but will not attempt to start it. Optional serial sources can be
passed with `BCR_CALIBRATION_NANO_SPECS`, for example
`BCR_CALIBRATION_NANO_SPECS="single@230400:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0,dual@230400:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"`.
Use `BCR_CALIBRATION_CAMERAS` to override the default camera list.
The default local configuration already uses those two Nano serial streams.
It addresses them by stable `/dev/serial/by-id` paths so reconnecting the
boards cannot swap the single-MPU FTDI board and dual-MPU CH340 board when
`/dev/ttyUSB0` and `/dev/ttyUSB1` are reassigned. Each calibration stream
event includes their raw parsed packets in the `accelerometers` field.

To show the actual camera windows while starting the same stack, add:

```bash
npm run dev -- --visualize-with-camera-gui --host 0.0.0.0 --port 5177
```

This replaces a running headless fiducial reader with the visual camera reader.
The camera windows are native OpenCV windows, not browser content. By default
they open on the local TigerVNC display `:1`; use
`BCR_CAMERA_GUI_DISPLAY=:0` before the command to place them on the physical
desktop instead. The camera grid is maximized to the available desktop work
area, leaving the taskbar visible.

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
live pose.

For now, a browser reload clears all calibration rows from the bridge and
starts a fresh calibration session. This prevents incomplete captures from
being reused while the 3D calibration is being validated.

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
