# Dual-MPU I2C scanner

Upload `dual_mpu_i2c_scan.ino` to the Arduino currently appearing as
`/dev/ttyUSB0`. It scans every legal 7-bit I2C address once every two seconds.

It prints one `I2C_DEVICE` line per responding address. For devices that allow
register reads, it also prints the value at MPU register `WHO_AM_I` (`0x75`).
MPU-compatible responses are marked with `mpu_candidate=1`.

After uploading, watch the result with:

```bash
stty -F /dev/ttyUSB0 230400 raw -echo
cat /dev/ttyUSB0
```

Stop the calibration bridge first so it releases `/dev/ttyUSB0`.
