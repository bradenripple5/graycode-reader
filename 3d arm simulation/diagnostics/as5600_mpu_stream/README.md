# USB1 AS5600 + MPU6050 stream

This is the exact prior firmware copied from `/home/pi/as5600_stream`.
It communicates at 230400 baud and emits the `SAMPLE` CSV format used by the
calibration bridge. It probes an MPU6050 at `0x68` and an AS5600 at `0x36`.

Tested on 2026-07-18: after flashing this exact firmware to `/dev/ttyUSB1`,
the board printed its `READY dual_sensor_stream` banner and CSV header but no
sample records. The sketch already enables a 3 ms Wire timeout, so this is not
a difference from the currently expected firmware. It indicates the USB1 I2C
bus or the attached sensor wiring is not responding.
