// WiFi Scout — passive 2.4 GHz access-point survey for ESP32.
//
// Each cycle the device:
//   1. runs an active scan plus a promiscuous sweep of channels 1-13,
//   2. decodes every beacon and probe response it hears into a rich AP record
//      (make/model via WPS, security detail, PHY generation, BSS load, ...),
//   3. joins the configured hotspot and POSTs the results to the dashboard,
//   4. drops the uplink and sleeps until the next cycle.
//
// Everything it collects is information routers broadcast publicly to any
// device in range. It never associates with them, injects traffic at them, or
// attempts authentication.

#include <Arduino.h>
#include <WiFi.h>

#include "config.h"
#include "settings.h"
#include "portal.h"
#include "sniffer.h"
#include "uploader.h"
#include "ap_table.h"
#include "ie_parser.h"   // authModeName()

static uint32_t s_seq          = 0;
static uint32_t s_uploads_ok   = 0;
static uint32_t s_uploads_fail = 0;

// Hold BOOT at power-on to clear stored credentials and return to the portal.
static bool bootButtonHeld() {
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);
  if (digitalRead(BOOT_BTN_PIN) != LOW) return false;

  Serial.print(F("[boot] BOOT held, keep holding to reset config "));
  uint32_t start = millis();
  while (digitalRead(BOOT_BTN_PIN) == LOW) {
    if (millis() - start > BOOT_BTN_HOLD_MS) {
      Serial.println(F("\n[boot] config cleared"));
      return true;
    }
    digitalWrite(LED_PIN, (millis() / 100) % 2);
    Serial.print('.');
    delay(100);
  }
  Serial.println(F("\n[boot] released early, keeping config"));
  return false;
}

static void blink(int times, int onMs, int offMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(onMs);
    digitalWrite(LED_PIN, LOW);  delay(offMs);
  }
}

// Console dump of the capture table — the only feedback available when
// watching over USB with no dashboard configured yet.
static void printApSummary(const SniffStats& st) {
  Serial.printf("[cap] %u APs | %u frames (%u dropped) | scan saw %u | %lu ms\n",
                g_aps.size(), st.frames_captured, st.frames_dropped,
                st.scan_records, (unsigned long)st.duration_ms);
  if (g_aps.dropped()) {
    Serial.printf("[cap] table full, %u APs not recorded\n", g_aps.dropped());
  }

  for (uint16_t i = 0; i < g_aps.size(); i++) {
    ApRecord* r = g_aps.at(i);

    Serial.printf("  %02x:%02x:%02x:%02x:%02x:%02x  ch%-3d %4d dBm  %-15s %s\n",
                  r->bssid[0], r->bssid[1], r->bssid[2],
                  r->bssid[3], r->bssid[4], r->bssid[5],
                  r->channel, r->rssi_best,
                  authModeName(r->authmode),
                  r->hidden ? "<hidden>" : r->ssid);

    // Second line carries what the beacon parser decoded, so a glance at the
    // console confirms the information elements are being read.
    const char* gen = r->phy_11be ? "Wi-Fi 7" : r->phy_11ax ? "Wi-Fi 6"
                    : r->phy_11ac ? "Wi-Fi 5" : r->phy_11n ? "Wi-Fi 4"
                    : r->phy_11g  ? "11g"     : r->phy_11b ? "11b" : "?";
    Serial.printf("      %-7s %3u MHz  %uss  %u Mbps  beacon %u/probe %u",
                  gen, r->bandwidth_mhz, r->spatial_streams,
                  r->max_rate_mbps, r->beacons, r->probe_resps);
    if (r->tsf) {
      unsigned long upSec = (unsigned long)(r->tsf / 1000000ULL);
      Serial.printf("  up %lud%luh", upSec / 86400, (upSec % 86400) / 3600);
    }
    if (r->has_qbss)   Serial.printf("  clients %u (%u%%)", r->station_count,
                                     (r->channel_util * 100) / 255);
    if (r->has_country) Serial.printf("  %s", r->country);
    if (r->pmf_required) Serial.print("  PMF-req");
    else if (r->pmf_capable) Serial.print("  PMF");
    if (r->rrm_11k) Serial.print("  11k");
    if (r->btm_11v) Serial.print("  11v");
    if (r->ft_11r)  Serial.print("  11r");
    if (r->wps_active) Serial.print("  WPS");
    Serial.println();

    if (r->wps_manufacturer[0] || r->wps_model_name[0]) {
      Serial.printf("      MODEL: %s %s %s\n", r->wps_manufacturer,
                    r->wps_model_name, r->wps_model_number);
    }
  }
}

static void printBanner() {
  Serial.println();
  Serial.println(F("=========================================="));
  Serial.println(F("  WiFi Scout " FW_VERSION));
  Serial.printf ("  Device   : %s\n", deviceMac().c_str());
  Serial.printf ("  Uplink   : %s\n", g_cfg.wifi_ssid);
  Serial.printf ("  Server   : %s\n", g_cfg.server);
  Serial.printf ("  Interval : %lu s\n", (unsigned long)(g_cfg.interval_ms / 1000));
  Serial.println(F("=========================================="));
}

void setup() {
  Serial.begin(115200);
  delay(400);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  settingsLoad();

  if (bootButtonHeld()) {
    settingsErase();
    settingsLoad();
    runConfigPortal();          // never returns; reboots on save
  }

  if (!g_cfg.configured() || g_cfg.server[0] == '\0') {
    Serial.println(F("[boot] no configuration stored"));
    Serial.println(F("[boot] running one scan so you can confirm the radio works"));
    digitalWrite(LED_PIN, HIGH);
    SniffStats st = runCapture();
    digitalWrite(LED_PIN, LOW);
    printApSummary(st);
    runConfigPortal();          // never returns
  }

  printBanner();
  blink(3, 80, 80);
}

void loop() {
  uint32_t cycleStart = millis();
  s_seq++;

  Serial.printf("\n[%lu] --- capture pass %lu ---\n",
                (unsigned long)(millis() / 1000), (unsigned long)s_seq);

  digitalWrite(LED_PIN, HIGH);
  SniffStats st = runCapture();
  digitalWrite(LED_PIN, LOW);

  printApSummary(st);

  UploadResult up = uploadResults(st, s_seq);
  if (up.ok) {
    s_uploads_ok++;
    Serial.printf("[up] sent %u/%u batches OK\n", up.batches_sent, up.batches_total);
    blink(2, 60, 60);
  } else {
    s_uploads_fail++;
    Serial.printf("[up] FAILED (%u/%u batches, last code %d) — will retry next cycle\n",
                  up.batches_sent, up.batches_total, up.last_http_code);
    blink(5, 60, 60);
  }
  Serial.printf("[sys] uploads ok=%lu fail=%lu | free heap %lu B\n",
                (unsigned long)s_uploads_ok, (unsigned long)s_uploads_fail,
                (unsigned long)ESP.getFreeHeap());

  // Sleep out the remainder of the cycle. Light sleep rather than deep sleep
  // keeps the run counters and the NTP-synced clock alive across cycles.
  uint32_t elapsed = millis() - cycleStart;
  if (elapsed < g_cfg.interval_ms) {
    uint32_t remain = g_cfg.interval_ms - elapsed;
    Serial.printf("[sys] idle %lu s\n", (unsigned long)(remain / 1000));
    while (remain > 0) {
      uint32_t slice = remain > 1000 ? 1000 : remain;
      delay(slice);
      remain -= slice;
    }
  }
}
