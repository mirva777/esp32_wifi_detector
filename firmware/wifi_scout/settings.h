// settings.h — NVS-backed device configuration.
#pragma once

#include <Arduino.h>

struct Settings {
  char     wifi_ssid[33];
  char     wifi_pass[65];
  char     server[129];      // base URL, e.g. https://my-scout.vercel.app
  char     token[65];        // shared secret, sent as X-Scout-Token
  char     device_name[33];
  uint32_t interval_ms;

  bool configured() const { return wifi_ssid[0] != '\0'; }
};

extern Settings g_cfg;

void settingsLoad();
void settingsSave();
void settingsErase();

// "WiFiScout-8F68" — last two MAC octets, also used as the SoftAP name.
String deviceShortId();
String deviceMac();
