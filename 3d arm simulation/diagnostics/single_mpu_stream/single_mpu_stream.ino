#include <Wire.h>

static const uint32_t BAUD = 230400;
static const uint8_t MPU_ADDR = 0x68;

static int16_t read16(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 2);
  int16_t hi = Wire.read();
  int16_t lo = Wire.read();
  return (hi << 8) | lo;
}

static bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool mpuPresent() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 1) != 1) return false;
  return Wire.read() == 0x68;
}

void setup() {
  Serial.begin(BAUD);
  delay(1000);
  Wire.begin();
  Wire.setClock(100000);
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif

  Serial.println(F("READY mpu6050_stream"));
  if (!mpuPresent()) {
    Serial.println(F("ERR MPU6050 not found at 0x68"));
    return;
  }

  writeReg(0x6B, 0x00); // PWR_MGMT_1: wake
  writeReg(0x1C, 0x00); // ACCEL_CONFIG: +/-2g
  writeReg(0x1B, 0x00); // GYRO_CONFIG: +/-250 deg/s
  Serial.println(F("MPU6050 OK"));
  Serial.println(F("ms,ax_g,ay_g,az_g,temp_c,gx_dps,gy_dps,gz_dps"));
}

void loop() {
  if (!mpuPresent()) {
    Serial.println(F("ERR MPU6050 lost"));
    delay(500);
    return;
  }

  int16_t ax = read16(0x3B);
  int16_t ay = read16(0x3D);
  int16_t az = read16(0x3F);
  int16_t temp = read16(0x41);
  int16_t gx = read16(0x43);
  int16_t gy = read16(0x45);
  int16_t gz = read16(0x47);

  Serial.print(millis());
  Serial.print(',');
  Serial.print(ax / 16384.0f, 3);
  Serial.print(',');
  Serial.print(ay / 16384.0f, 3);
  Serial.print(',');
  Serial.print(az / 16384.0f, 3);
  Serial.print(',');
  Serial.print((temp / 340.0f) + 36.53f, 2);
  Serial.print(',');
  Serial.print(gx / 131.0f, 2);
  Serial.print(',');
  Serial.print(gy / 131.0f, 2);
  Serial.print(',');
  Serial.println(gz / 131.0f, 2);

  delay(100);
}
