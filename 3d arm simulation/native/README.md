# Calibration bridge

`calibration_bridge.py` is the local HTTP, UDP, and serial bridge used by
`npm run dev`. It is kept in this project so the launcher does not depend on a
sibling directory.

Each joint estimate circular-averages the five most recent valid readings from
each physical sensor, then fuses the available sensor windows. Fusion weight is
proportional to each sensor's observed delivery rate as well as its configured
camera/accelerometer trust weight, so a faster accelerometer gives a more
real-time estimate. Missing or stale inputs are excluded; for example, the
wrist falls back to its camera-only estimate when accelerometer data stops.

Before gyro/complementary filtering, each accelerometer uses a time-aware
least-squares line fitted to its latest 10 angle readings and evaluates that
line at the newest timestamp. Estimation begins after five valid readings and
correctly unwraps angles across ±180°. Configure the estimator with
`--accel-polynomial-window` and `--accel-polynomial-degree`.
