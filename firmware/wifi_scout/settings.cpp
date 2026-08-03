#include "settings.h"
#include "config.h"

#include <Preferences.h>
#include <WiFi.h>
#include <string.h>

Settings g_cfg;

static Preferences prefs;
static const char* NS = "scout";

static void copyInto(char* dst, size_t cap, const String& src) {
  strncpy(dst, src.c_str(), cap - 1);
  dst[cap - 1] = '\0';
}

String deviceMac() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

String deviceShortId() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[5];
  snprintf(buf, sizeof(buf), "%02X%02X", mac[4], mac[5]);
  return String(buf);
}

void settingsLoad() {
  memset(&g_cfg, 0, sizeof(g_cfg));

  prefs.begin(NS, true);                       // read-only
  copyInto(g_cfg.wifi_ssid,   sizeof g_cfg.wifi_ssid,   prefs.getString("ssid",   DEFAULT_WIFI_SSID));
  copyInto(g_cfg.wifi_pass,   sizeof g_cfg.wifi_pass,   prefs.getString("pass",   DEFAULT_WIFI_PASS));
  copyInto(g_cfg.server,      sizeof g_cfg.server,      prefs.getString("server", DEFAULT_SERVER));
  copyInto(g_cfg.token,       sizeof g_cfg.token,       prefs.getString("token",  DEFAULT_TOKEN));
  copyInto(g_cfg.device_name, sizeof g_cfg.device_name, prefs.getString("name",   ""));
  g_cfg.interval_ms = prefs.getULong("interval", CYCLE_INTERVAL_MS);
  prefs.end();

  if (g_cfg.device_name[0] == '\0') {
    String n = String("scout-") + deviceShortId();
    copyInto(g_cfg.device_name, sizeof g_cfg.device_name, n);
  }
  if (g_cfg.interval_ms < 30000UL) g_cfg.interval_ms = 30000UL;
}

void settingsSave() {
  prefs.begin(NS, false);
  prefs.putString("ssid",   g_cfg.wifi_ssid);
  prefs.putString("pass",   g_cfg.wifi_pass);
  prefs.putString("server", g_cfg.server);
  prefs.putString("token",  g_cfg.token);
  prefs.putString("name",   g_cfg.device_name);
  prefs.putULong("interval", g_cfg.interval_ms);
  prefs.end();
}

void settingsErase() {
  prefs.begin(NS, false);
  prefs.clear();
  prefs.end();
  memset(&g_cfg, 0, sizeof(g_cfg));
}
