#include <Wire.h>

static const uint32_t BAUD = 230400;
static const uint8_t MPU_ADDRS[] = {0x68, 0x69};
static const uint8_t MPU_N = sizeof(MPU_ADDRS) / sizeof(MPU_ADDRS[0]);
static bool mpuReady[MPU_N] = {false, false};
static uint32_t lastScanMs = 0;

static bool readByte(uint8_t addr, uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 1) != 1) return false;
  value = Wire.read();
  return true;
}

static bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool mpuPresent(uint8_t addr) {
  uint8_t who = 0;
  return readByte(addr, 0x75, who) && who == 0x68;
}

static bool initMpu(uint8_t addr) {
  uint8_t who = 0;
  Wire.beginTransmission(addr);
  if (Wire.endTransmission() != 0) return false;
  if (!readByte(addr, 0x75, who) || who != 0x68) return false;
  writeReg(addr, 0x6B, 0x00);
  writeReg(addr, 0x1C, 0x00);
  writeReg(addr, 0x1B, 0x00);
  return true;
}

static uint8_t scanMpus() {
  uint8_t count = 0;
  for (uint8_t i = 0; i < MPU_N; i++) {
    mpuReady[i] = initMpu(MPU_ADDRS[i]);
    if (mpuReady[i]) count++;
  }
  Serial.print(F("C,"));
  Serial.println(count);
  return count;
}

static bool readMpuBurst(uint8_t addr, int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(addr);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 14) != 14) return false;
  ax = ((int16_t)Wire.read() << 8) | Wire.read();
  ay = ((int16_t)Wire.read() << 8) | Wire.read();
  az = ((int16_t)Wire.read() << 8) | Wire.read();
  Wire.read(); Wire.read();
  gx = ((int16_t)Wire.read() << 8) | Wire.read();
  gy = ((int16_t)Wire.read() << 8) | Wire.read();
  gz = ((int16_t)Wire.read() << 8) | Wire.read();
  return true;
}

static void printMpuRow(uint8_t addr) {
  int16_t ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0;
  if (!readMpuBurst(addr, ax, ay, az, gx, gy, gz)) return;
  Serial.print(F("A,")); Serial.print(addr, HEX); Serial.print(',');
  Serial.print(ax); Serial.print(','); Serial.print(ay); Serial.print(','); Serial.print(az); Serial.print(',');
  Serial.print(gx); Serial.print(','); Serial.print(gy); Serial.print(','); Serial.println(gz);
}

void setup() {
  Serial.begin(BAUD);
  delay(500);
#if defined(A4)
  pinMode(A4, INPUT_PULLUP);
#endif
#if defined(A5)
  pinMode(A5, INPUT_PULLUP);
#endif
  Wire.begin();
  Wire.setClock(400000);
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif
  Serial.println(F("R,dual"));
  scanMpus();
  lastScanMs = millis();
}

void loop() {
  bool anyReady = false;
  for (uint8_t i = 0; i < MPU_N; i++) if (mpuReady[i]) anyReady = true;
  if (!anyReady) {
    if (millis() - lastScanMs >= 1000) { lastScanMs = millis(); scanMpus(); }
    delay(0);
    return;
  }
  bool lostAny = false;
  for (uint8_t i = 0; i < MPU_N; i++) {
    if (mpuReady[i] && !mpuPresent(MPU_ADDRS[i])) { mpuReady[i] = false; lostAny = true; }
  }
  if (lostAny) scanMpus();
  for (uint8_t i = 0; i < MPU_N; i++) if (mpuReady[i]) printMpuRow(MPU_ADDRS[i]);
  delay(0);
}
