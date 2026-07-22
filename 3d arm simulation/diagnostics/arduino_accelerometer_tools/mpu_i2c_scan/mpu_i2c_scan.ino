#include <Wire.h>

static const uint32_t BAUD = 115200;

static bool readWhoAmI(uint8_t addr, uint8_t &value) {
  Wire.beginTransmission(addr);
  Wire.write(0x75);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, 1) != 1) return false;
  value = Wire.read();
  return true;
}

static void scanOnce() {
  bool any = false;
  Serial.println(F("I2C scan start"));
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;
    any = true;
    Serial.print(F("FOUND 0x"));
    if (addr < 16) Serial.print('0');
    Serial.print(addr, HEX);
    if (addr == 0x68 || addr == 0x69) {
      uint8_t who = 0;
      if (readWhoAmI(addr, who)) {
        Serial.print(F(" WHO_AM_I=0x"));
        if (who < 16) Serial.print('0');
        Serial.print(who, HEX);
        if (who == 0x68) Serial.print(F(" MPU6050_OK"));
      } else {
        Serial.print(F(" WHO_AM_I_READ_FAILED"));
      }
    }
    Serial.println();
  }
  if (!any) Serial.println(F("NO_I2C_DEVICES_FOUND"));
  Serial.println(F("I2C scan done"));
}

void setup() {
  Serial.begin(BAUD);
  delay(1000);
  Wire.begin();
  Wire.setClock(100000);
  Serial.println(F("READY mpu_i2c_scan"));
  scanOnce();
}

void loop() {
  delay(2000);
  scanOnce();
}
