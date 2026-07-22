#include <Wire.h>

constexpr uint8_t kMpuWhoAmIRegister = 0x75;
constexpr unsigned long kScanIntervalMs = 2000;

bool readRegister(uint8_t address, uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, static_cast<uint8_t>(1)) != 1) return false;
  value = Wire.read();
  return true;
}

void printHex(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void scanI2cBus() {
  Serial.println("I2C_SCAN_BEGIN");
  uint8_t deviceCount = 0;

  for (uint8_t address = 1; address < 127; ++address) {
    Wire.beginTransmission(address);
    const uint8_t error = Wire.endTransmission();
    if (error != 0) continue;

    ++deviceCount;
    Serial.print("I2C_DEVICE address=0x");
    printHex(address);

    uint8_t whoAmI = 0;
    if (readRegister(address, kMpuWhoAmIRegister, whoAmI)) {
      Serial.print(" who_am_i=0x");
      printHex(whoAmI);
      if (whoAmI == 0x68 || whoAmI == 0x69 || whoAmI == 0x70 || whoAmI == 0x71) {
        Serial.print(" mpu_candidate=1");
      }
    }
    Serial.println();
  }

  Serial.print("I2C_SCAN_END devices=");
  Serial.println(deviceCount);
}

void setup() {
  Serial.begin(230400);
  Wire.begin();
  delay(250);
  Serial.println("DUAL_MPU_I2C_DIAGNOSTIC_READY");
}

void loop() {
  scanI2cBus();
  delay(kScanIntervalMs);
}
