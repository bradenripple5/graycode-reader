#include <Wire.h>

static const uint32_t BAUD = 230400;
static const uint16_t SAMPLE_INTERVAL_MS = 10;

// Fixed I2C Addresses
static const uint8_t MPU_ADDR = 0x68;
static const uint8_t AS5600_ADDR = 0x36;

static bool mpuPresent = false;
static bool as5600Present = false;
static uint32_t lastSampleMs = 0;

static int16_t make16(uint8_t hi, uint8_t lo) { 
  return (hi << 8) | lo; 
}

static bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool checkMpu() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75); // WHO_AM_I register
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 1) != 1) return false;
  return Wire.read() == 0x68;
}

static bool checkEncoder() {
  Wire.beginTransmission(AS5600_ADDR);
  return Wire.endTransmission() == 0;
}

// Reads all 14 sequential MPU6050 data registers
static bool readMpuData(int16_t &ax, int16_t &ay, int16_t &az, int16_t &temp, int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B); // Starting register for Accel X High
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14) != 14) return false;
  
  uint8_t b[14];
  for (uint8_t i = 0; i < 14; i++) {
    b[i] = Wire.read();
  }
  
  ax = make16(b[0], b[1]);
  ay = make16(b[2], b[3]);
  az = make16(b[4], b[5]);
  temp = make16(b[6], b[7]);
  gx = make16(b[8], b[9]);
  gy = make16(b[10], b[11]);
  gz = make16(b[12], b[13]);
  return true;
}

// Reads 2 sequential AS5600 data registers
static bool readEncoderData(uint16_t &rawAngle) {
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(0x0C); // Raw angle register address
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)AS5600_ADDR, 2) != 2) return false;
  
  uint8_t hi = Wire.read();
  uint8_t lo = Wire.read();
  
  rawAngle = make16(hi, lo) & 0x0FFF; // Mask 12-bit payload
  return true;
}

void setup() {
  Serial.begin(BAUD);
  delay(1000);
  Wire.begin();
  Wire.setClock(100000);
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif
  delay(100);
  
  Serial.println(F("READY dual_sensor_stream"));
  Serial.println(F("ms,type,mpu_ok,ax,ay,az,temp,gx,gy,gz,as5600_ok,raw_angle,degrees"));
  
  // Verify and initialize MPU6050
  if (!checkMpu()) {
    Serial.println(F("0,ERR,0x68,MPU6050_NOT_FOUND,0,0,0,0,0,0"));
  } else {
    mpuPresent = true;
    writeReg(MPU_ADDR, 0x6B, 0x00); // Wake up device
    delay(100);
    writeReg(MPU_ADDR, 0x1C, 0x00); // Set Accel to +/-2g
    writeReg(MPU_ADDR, 0x1B, 0x00); // Set Gyro to +/-250 dps
    Serial.println(F("0,MSG,0x68,MPU6050_INITIALIZED"));
  }
  
  // Verify AS5600
  if (!checkEncoder()) {
    Serial.println(F("0,ERR,0x36,AS5600_NOT_FOUND,0,0,0,0,0,0"));
  } else {
    as5600Present = true;
    Serial.println(F("0,MSG,0x36,AS5600_INITIALIZED"));
  }
}

void loop() {
  uint32_t now = millis();

  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleMs = now;

  int16_t ax = 0;
  int16_t ay = 0;
  int16_t az = 0;
  int16_t temp = 0;
  int16_t gx = 0;
  int16_t gy = 0;
  int16_t gz = 0;
  bool mpuOk = false;
  if (mpuPresent) {
    mpuOk = readMpuData(ax, ay, az, temp, gx, gy, gz);
  }

  uint16_t rawAngle = 0;
  bool as5600Ok = false;
  if (as5600Present) {
    as5600Ok = readEncoderData(rawAngle);
  }

  Serial.print(now);
  Serial.print(F(",SAMPLE,"));
  Serial.print(mpuOk ? 1 : 0);       Serial.print(',');
  Serial.print(ax / 16384.0f, 3);    Serial.print(',');
  Serial.print(ay / 16384.0f, 3);    Serial.print(',');
  Serial.print(az / 16384.0f, 3);    Serial.print(',');
  Serial.print((temp / 340.0f) + 36.53f, 2); Serial.print(',');
  Serial.print(gx / 131.0f, 2);      Serial.print(',');
  Serial.print(gy / 131.0f, 2);      Serial.print(',');
  Serial.print(gz / 131.0f, 2);      Serial.print(',');
  Serial.print(as5600Ok ? 1 : 0);    Serial.print(',');
  Serial.print(rawAngle);            Serial.print(',');
  Serial.println(rawAngle * (360.0f / 4096.0f), 2);
}
