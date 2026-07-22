# Arduino accelerometer tools

These are copies of the working sketches found on this machine.

- `accel_dual_live/accel_dual_live.ino` is the normal two-MPU streaming firmware. It probes MPU6050 devices at I2C addresses `0x68` and `0x69`, then emits raw accelerometer and gyro values at 500000 baud.
- `mpu_i2c_scan/mpu_i2c_scan.ino` is a diagnostic sketch. It scans every valid I2C address (`0x08` through `0x77`) every two seconds and checks the MPU6050 identity register at `0x68` and `0x69`. It uses 115200 baud.

The scan performed on 2026-07-18 found no I2C devices on `/dev/ttyUSB0`. The normal dual-MPU firmware was restored afterwards.
