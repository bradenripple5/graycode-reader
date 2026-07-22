# Native camera reader and GUI

This directory contains everything needed to build or run the camera 0 native reader used by the 3D arm calibration setup.

- `basic_fiducial_reader` is the ready-to-run ARM64 Linux executable.
- `basic_fiducial_reader.cpp` is its source code.
- `Makefile` rebuilds it with `make basic_fiducial_reader` (requires `g++`, `make`, `pkg-config`, and OpenCV development files).
- `run_camera_gui.sh` starts the camera 0 window and sends angle readings to the calibration bridge at UDP port `5010`.
- `completions/basic_fiducial_reader.bash` provides optional Bash tab completion.

Run the GUI:

```bash
cd diagnostics/camera_reader
bash run_camera_gui.sh
```

The launcher uses the USB camera's `index=0` capture node directly. Use
`CAMERAS=0 DISPLAY=:0 bash run_camera_gui.sh` to explicitly select camera 0
and put the GUI on the physical display. It
intentionally does **not** use `--no-window`, so the live camera 0 window remains
visible.

Each visible ArUco code supplies its own upward-angle estimate from its
canonical corner orientation and ID position. The emitted angle is their
area-weighted circular average, so a matching inner/outer marker pair is not
required. Set `RING_POSITIONS` to match the number of positions printed around
the wheel (default `19`).

The reader needs access to the V4L2 camera devices and a graphical X display. It emits its angle packets to `127.0.0.1:5010`; start the calibration bridge as well if you want the browser to receive those packets.

Browser video streaming has been removed to avoid the continuous JPEG encoding
load on the Pi. Headless mode still performs fiducial detection and sends its
numeric angle telemetry to the calibration bridge.

## Four-marker arm calibration

`aruco_pose_reader` is the separate pose-calibration reader for standard OpenCV
`DICT_4X4_50` markers 0 through 3. Marker 0 belongs on the base, marker 1 on the
shoulder link, marker 2 on the elbow link, and marker 3 on the wrist link. Do
not place a marker on the gripper.

Printable 40 mm SVG files are in `aruco_markers/`. Print them at 100% / actual
size and verify the black square is exactly 40 mm. If a different printed size
is used, pass that side length to `--aruco-marker-length` in meters.

Start the complete bridge, reader, and browser workflow with:

```bash
npm run dev -- --aruco-calibration --visualize-with-camera-gui \
  --host 0.0.0.0 --port 5176
```

Then open `http://<pi-address>:5176/aruco-calibration.html`. For accurate 3D
translation, supply an OpenCV intrinsics file:

```bash
npm run dev -- --aruco-calibration \
  --aruco-marker-length 0.04 \
  --aruco-camera-calibration /path/to/camera.yml \
  --host 0.0.0.0 --port 5176
```

The YAML file must contain `camera_matrix` and `distortion_coefficients`.
Without it, the reader uses approximate intrinsics; rotation-based joint
calibration still runs, but translation is marked diagnostic only.

Every processed camera frame sent to the calibration bridge contains the pose
rotation vector, translation vector, and image corners for each visible marker.
The bridge stores that frame with the most recent complete XYZ acceleration,
XYZ gyro, temperature, angle, timing, and camera-time offset for every MPU feed.
