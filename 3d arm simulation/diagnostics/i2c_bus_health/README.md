# I2C bus health diagnostic

Flashing this to an Arduino Nano at 230400 baud reports the physical states of
SDA (A4) and SCL (A5), tries to release a stuck I2C bus with clock pulses, and
keeps reporting the pin levels. Both lines should normally read `HIGH` when
idle. A persistent `LOW` indicates a wiring, power, or stuck-device problem.
