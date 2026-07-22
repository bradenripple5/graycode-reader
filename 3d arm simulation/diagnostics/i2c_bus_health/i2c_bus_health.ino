#include <Wire.h>

static const uint32_t BAUD = 230400;
static const uint8_t SDA_PIN = A4;
static const uint8_t SCL_PIN = A5;

static void releaseBus() {
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
  delay(2);

  // If a device abandoned a transaction, pulse SCL up to nine times to let it
  // finish, then generate a STOP condition before handing control to Wire.
  for (uint8_t pulse = 0; pulse < 9 && digitalRead(SDA_PIN) == LOW; pulse++) {
    pinMode(SCL_PIN, OUTPUT);
    digitalWrite(SCL_PIN, LOW);
    delayMicroseconds(8);
    pinMode(SCL_PIN, INPUT_PULLUP);
    delayMicroseconds(8);
  }
  pinMode(SDA_PIN, OUTPUT);
  digitalWrite(SDA_PIN, LOW);
  delayMicroseconds(8);
  pinMode(SCL_PIN, INPUT_PULLUP);
  delayMicroseconds(8);
  pinMode(SDA_PIN, INPUT_PULLUP);
  delayMicroseconds(8);
}

static void reportPins(const char *stage) {
  Serial.print(F("PINS,"));
  Serial.print(stage);
  Serial.print(F(",SDA="));
  Serial.print(digitalRead(SDA_PIN) ? F("HIGH") : F("LOW"));
  Serial.print(F(",SCL="));
  Serial.println(digitalRead(SCL_PIN) ? F("HIGH") : F("LOW"));
}

void setup() {
  Serial.begin(BAUD);
  delay(500);
  Serial.println(F("READY i2c_bus_health"));
  pinMode(SDA_PIN, INPUT_PULLUP);
  pinMode(SCL_PIN, INPUT_PULLUP);
  reportPins("before_recovery");
  releaseBus();
  reportPins("after_recovery");
}

void loop() {
  reportPins("live");
  delay(500);
}
