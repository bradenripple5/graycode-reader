# USB1 single-MPU firmware

This is the no-AS5600 firmware for the USB1 board. It reads one MPU6050 at
I2C address `0x68` and emits raw accelerometer and gyro data at **230400 baud**
in the eight-field CSV format consumed by the calibration bridge.

It is intentionally separate from `as5600_mpu_stream`; do not use the AS5600
firmware for this board.
