# graycode_reader

## Quick start

Initially, run the dev server:

```bash
npm run dev
```

Side note on versioning: the project includes `versioning.html` / `versioning.js` for the versioning UI/logic.

## Local server (HTTP)

Serves `index.html` and `pattern.json` over HTTP.

```bash
python3 server.py
```

## Native readers

The native OpenCV readers live in `native/`. Build outputs are intentionally
ignored because binaries built on this x86 Linux machine will not run on the
Raspberry Pi, and Pi-built ARM64 binaries will not run here.

### Build on this Linux machine

Install OpenCV development headers if needed:

```bash
sudo apt install build-essential pkg-config libopencv-dev
```

Build both native readers:

```bash
cd native
make
```

Launch the local GUI for starting/stopping native readers:

```bash
python3 scripts/native_reader_gui.py
```

Run the latest grayscale direction reader on all detected cameras:

```bash
./grayscale_direction_reader --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window
```

Run one camera explicitly:

```bash
./grayscale_direction_reader --camera 0 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window
```

### Build on the Raspberry Pi

SSH to the Pi and build from the Pi checkout:

```bash
ssh pi@10.0.0.188
cd ~/graycode_reader/native
make -B grayscale_direction_reader
make -B basic_fiducial_reader
file grayscale_direction_reader basic_fiducial_reader
```

The `file` command should report `ARM aarch64` for both binaries. If it reports
`x86-64`, rebuild on the Pi with `make -B`.

Inside the TigerVNC desktop on the Pi, launch the local GUI:

```bash
cd ~/graycode_reader
python3 scripts/native_reader_gui.py
```

Use `DISPLAY=:1 python3 scripts/native_reader_gui.py` if launching it from SSH
and showing it inside the TigerVNC desktop.

The four USB cameras have been seen as `/dev/video0`, `/dev/video2`,
`/dev/video4`, and `/dev/video6`. Run the latest reader against one camera:

```bash
./grayscale_direction_reader --camera 0 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window
```

Run all four explicitly from separate shells or background jobs:

```bash
./grayscale_direction_reader --camera 0 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window &
./grayscale_direction_reader --camera 2 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window &
./grayscale_direction_reader --camera 4 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window &
./grayscale_direction_reader --camera 6 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window &
```

`basic_fiducial_reader` has native UDP telemetry:

```bash
./basic_fiducial_reader --cameras 0,2,4,6 --width 640 --height 480 --fps 30 --process-fps 10 --downscale 320 --no-window --udp-target 127.0.0.1:5001
```

`udp_reader.py` can either listen to the basic reader's native UDP stream or
launch the latest grayscale reader and bridge its stdout angle readings:

```bash
cd ~/graycode_reader/native

# Start basic_fiducial_reader and subscribe to its UDP output.
python3 udp_reader.py --mode basic --start-reader --cameras 0,2,4,6 --ring-fit

# Launch one grayscale_direction_reader per camera and print JSON readings.
python3 udp_reader.py --mode grayscale --cameras 0,2,4,6

# Also forward the bridged grayscale readings over UDP.
python3 udp_reader.py --mode grayscale --cameras 0,2,4,6 --udp-target 127.0.0.1:5001
```

If `python3 udp_reader.py` appears idle, it is waiting for packets from an
already-running basic reader. Use `--start-reader` for basic mode or
`--mode grayscale` for the latest grayscale reader.

## Phone camera access (HTTPS required)

Mobile browsers require a secure origin to access the camera. Use HTTPS with a
locally trusted CA:

1) Generate a local CA and server cert for your IP (auto-detects if omitted):

```bash
./make-certs.sh 10.0.0.87
```

2) Install `ca.crt` on your phone as a CA certificate.

3) Run the HTTPS server:

```bash
python3 server.py --host 0.0.0.0 --port 8000 --https --cert server.crt --key server.key
```

4) Open:

`https://10.0.0.87:8000/`

## Android (Pattern) app scaffold

An Android Studio-ready pattern viewer lives in `android/`.

- Open `android/` in Android Studio (latest).
- `minSdk` is 24.
- JSON pattern data lives at `android/app/src/main/assets/pattern.json`.
- CLI build:
  - `cd android && ./gradlew assembleDebug`
- Install to a connected device:
  - `cd android && ./gradlew installDebug`
  - or `./android/install-debug.sh`
