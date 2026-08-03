#include "uploader.h"
#include "config.h"
#include "settings.h"
#include "ap_table.h"
#include "ie_parser.h"

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
static void jsonStr(String& out, const char* s) {
  out += '"';
  for (const char* p = s; *p; p++) {
    char c = *p;
    if (c == '"' || c == '\\')      { out += '\\'; out += c; }
    else if ((uint8_t)c < 0x20)     { out += ' '; }
    else                            { out += c; }
  }
  out += '"';
}

static void kvStr(String& out, const char* k, const char* v, bool comma = true) {
  out += '"'; out += k; out += "\":";
  jsonStr(out, v);
  if (comma) out += ',';
}

static void kvNum(String& out, const char* k, long v, bool comma = true) {
  out += '"'; out += k; out += "\":"; out += v;
  if (comma) out += ',';
}

static void kvBool(String& out, const char* k, bool v, bool comma = true) {
  out += '"'; out += k; out += "\":"; out += (v ? "true" : "false");
  if (comma) out += ',';
}

static void hexBytes(String& out, const uint8_t* b, size_t n) {
  static const char* H = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out += H[b[i] >> 4]; out += H[b[i] & 0x0F]; }
}

static String macStr(const uint8_t m[6]) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x",
           m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(buf);
}

// Marketing generation name, derived from the capability elements we decoded.
static const char* phyGeneration(const ApRecord* r) {
  if (r->phy_11be) return "Wi-Fi 7";
  if (r->phy_11ax) return "Wi-Fi 6";
  if (r->phy_11ac) return "Wi-Fi 5";
  if (r->phy_11n)  return "Wi-Fi 4";
  if (r->phy_11g)  return "802.11g";
  if (r->phy_11b)  return "802.11b";
  return "unknown";
}

// ---------------------------------------------------------------------------
// One AP as a JSON object
// ---------------------------------------------------------------------------
static void serialiseAp(String& j, ApRecord* r) {
  j += '{';
  kvStr(j, "bssid", macStr(r->bssid).c_str());
  kvStr(j, "ssid", r->ssid);

  j += "\"ssid_hex\":\"";
  hexBytes(j, r->ssid_raw, r->ssid_len);
  j += "\",";

  kvBool(j, "hidden", r->hidden);
  kvNum(j, "rssi", r->rssi_best);
  kvNum(j, "rssi_last", r->rssi_last);
  kvNum(j, "channel", r->channel);
  kvNum(j, "sec_chan", r->sec_chan_offset);
  kvNum(j, "bandwidth", r->bandwidth_mhz);
  kvStr(j, "auth", authModeName(r->authmode));

  // --- security -----------------------------------------------------------
  j += "\"security\":{";
  kvBool(j, "wep", r->wep);
  kvBool(j, "wpa1", r->wpa1);
  kvBool(j, "wpa2", r->wpa2);
  kvBool(j, "wpa3", r->wpa3);
  kvBool(j, "owe", r->owe);
  kvBool(j, "open", !r->privacy && !r->wpa1 && !r->wpa2);
  kvBool(j, "psk", r->akm_psk);
  kvBool(j, "sae", r->akm_sae);
  kvBool(j, "dot1x", r->akm_8021x);
  kvBool(j, "ft", r->akm_ft);
  kvBool(j, "suiteb", r->akm_suiteb);
  kvBool(j, "pmf_capable", r->pmf_capable);
  kvBool(j, "pmf_required", r->pmf_required);
  kvStr(j, "pairwise", cipherName(r->pairwise_cipher));
  kvStr(j, "group", cipherName(r->group_cipher), false);
  j += "},";

  // --- PHY ----------------------------------------------------------------
  j += "\"phy\":{";
  kvBool(j, "b", r->phy_11b);
  kvBool(j, "g", r->phy_11g);
  kvBool(j, "n", r->phy_11n);
  kvBool(j, "ac", r->phy_11ac);
  kvBool(j, "ax", r->phy_11ax);
  kvBool(j, "be", r->phy_11be);
  kvBool(j, "lr", r->phy_lr);
  kvNum(j, "streams", r->spatial_streams);
  kvNum(j, "max_mbps", r->max_rate_mbps);
  kvStr(j, "generation", phyGeneration(r), false);
  j += "},";

  // --- WPS device descriptor ----------------------------------------------
  j += "\"wps\":{";
  kvBool(j, "active", r->wps_active);
  kvNum(j, "state", r->wps_state);
  kvStr(j, "manufacturer", r->wps_manufacturer);
  kvStr(j, "model_name", r->wps_model_name);
  kvStr(j, "model_number", r->wps_model_number);
  kvStr(j, "device_name", r->wps_device_name);
  kvStr(j, "serial", r->wps_serial);
  kvStr(j, "category", wpsCategoryName(r->wps_primary_cat));
  j += "\"uuid\":\"";
  if (r->has_uuid) hexBytes(j, r->wps_uuid, 16);
  j += "\"},";

  // --- beacon fixed fields ------------------------------------------------
  j += "\"beacon\":{";
  kvNum(j, "interval_tu", r->beacon_interval);
  kvNum(j, "dtim", r->dtim_period);
  kvNum(j, "capability", r->capability);
  // TSF counts microseconds since the AP last reset its timer, which in
  // practice means since it last rebooted.
  kvNum(j, "uptime_s", (long)(r->tsf / 1000000ULL), false);
  j += "},";

  // --- BSS load -----------------------------------------------------------
  j += "\"load\":{";
  kvBool(j, "present", r->has_qbss);
  kvNum(j, "stations", r->station_count);
  kvNum(j, "utilization_pct", (r->channel_util * 100) / 255, false);
  j += "},";

  // --- regulatory ---------------------------------------------------------
  j += "\"country\":{";
  kvStr(j, "code", r->country);
  kvNum(j, "max_tx_dbm", r->max_tx_power);
  kvNum(j, "first_chan", r->country_schan);
  kvNum(j, "num_chans", r->country_nchan, false);
  j += "},";

  // --- roaming / measurement features -------------------------------------
  j += "\"features\":{";
  kvBool(j, "rrm_11k", r->rrm_11k);
  kvBool(j, "btm_11v", r->btm_11v);
  kvBool(j, "ft_11r", r->ft_11r);
  kvBool(j, "ftm_responder", r->ftm_responder);
  kvBool(j, "ftm_initiator", r->ftm_initiator, false);
  j += "},";

  // --- vendor element OUIs ------------------------------------------------
  j += "\"vendor_ies\":[";
  for (uint8_t i = 0; i < r->vendor_oui_count; i++) {
    if (i) j += ',';
    char b[10];
    snprintf(b, sizeof(b), "\"%02x%02x%02x\"",
             r->vendor_ouis[i][0], r->vendor_ouis[i][1], r->vendor_ouis[i][2]);
    j += b;
  }
  j += "],";

  // --- observation stats --------------------------------------------------
  j += "\"stats\":{";
  kvNum(j, "beacons", r->beacons);
  kvNum(j, "probe_resps", r->probe_resps);
  kvBool(j, "in_scan", r->seen_in_scan);
  kvNum(j, "observed_ms", (long)(r->last_seen_ms - r->first_seen_ms), false);
  j += "}}";
}

// ---------------------------------------------------------------------------
// Uplink
// ---------------------------------------------------------------------------
static bool joinNetwork() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(g_cfg.wifi_ssid, g_cfg.wifi_pass);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_MS) {
      Serial.printf("[up] join failed, status=%d\n", WiFi.status());
      return false;
    }
    digitalWrite(LED_PIN, (millis() / 120) % 2);
    delay(50);
  }
  Serial.printf("[up] joined %s as %s (rssi %d)\n",
                g_cfg.wifi_ssid, WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

static bool postJson(const String& body, int& httpCode) {
  String url = String(g_cfg.server) + "/api/ingest";

  // Declared before `http` so it is destroyed *after* it — HTTPClient keeps a
  // reference to the client for the lifetime of the request.
  WiFiClientSecure tls;
  HTTPClient http;
  bool ok = false;

  if (url.startsWith("https://")) {
    // Skipping chain validation keeps the device working across certificate
    // rotations. The payload is public beacon metadata and the endpoint is
    // authenticated by the shared token below, so this is an acceptable
    // trade-off here; pin a root CA if you need stronger guarantees.
    tls.setInsecure();
    tls.setTimeout(HTTP_TIMEOUT_MS / 1000);
    ok = http.begin(tls, url);
  } else {
    ok = http.begin(url);
  }
  if (!ok) { httpCode = -1; return false; }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", deviceMac());
  if (g_cfg.token[0]) http.addHeader("X-Scout-Token", g_cfg.token);

  httpCode = http.POST((uint8_t*)body.c_str(), body.length());
  bool good = (httpCode >= 200 && httpCode < 300);
  if (!good) {
    Serial.printf("[up] POST %s -> %d %s\n", url.c_str(), httpCode,
                  httpCode > 0 ? http.getString().c_str() : "");
  }
  http.end();
  return good;
}

UploadResult uploadResults(const SniffStats& st, uint32_t seq) {
  UploadResult res = {};
  res.batches_total = (g_aps.size() + UPLOAD_BATCH - 1) / UPLOAD_BATCH;
  if (res.batches_total == 0) res.batches_total = 1;

  if (!joinNetwork()) return res;

  // Best-effort clock sync so the server sees real timestamps even if it is
  // the device that has been running longest.
  static bool timeSynced = false;
  if (!timeSynced) {
    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
    uint32_t t0 = millis();
    while (time(nullptr) < 1600000000UL && millis() - t0 < 6000) delay(200);
    timeSynced = time(nullptr) > 1600000000UL;
  }
  long epoch = timeSynced ? (long)time(nullptr) : 0;

  uint16_t total = g_aps.size();
  uint16_t sent  = 0;

  for (uint16_t start = 0; start < total || start == 0; start += UPLOAD_BATCH) {
    uint16_t end = start + UPLOAD_BATCH;
    if (end > total) end = total;

    String j;
    j.reserve(20000);
    j += '{';

    j += "\"device\":{";
    kvStr(j, "id", deviceMac().c_str());
    kvStr(j, "name", g_cfg.device_name);
    kvStr(j, "fw", FW_VERSION);
    kvStr(j, "ip", WiFi.localIP().toString().c_str());
    kvStr(j, "uplink_ssid", g_cfg.wifi_ssid);
    kvNum(j, "uplink_rssi", WiFi.RSSI());
    kvNum(j, "uptime_s", (long)(millis() / 1000));
    kvNum(j, "free_heap", (long)ESP.getFreeHeap(), false);
    j += "},";

    j += "\"capture\":{";
    kvNum(j, "seq", (long)seq);
    kvNum(j, "epoch", epoch);
    kvNum(j, "duration_ms", (long)st.duration_ms);
    kvNum(j, "frames", st.frames_captured);
    kvNum(j, "frames_dropped", st.frames_dropped);
    kvNum(j, "scan_records", st.scan_records);
    kvNum(j, "ap_total", total);
    kvNum(j, "table_overflow", g_aps.dropped());
    kvNum(j, "batch", start / UPLOAD_BATCH);
    kvNum(j, "batches", res.batches_total, false);
    j += "},";

    j += "\"aps\":[";
    for (uint16_t i = start; i < end; i++) {
      if (i > start) j += ',';
      serialiseAp(j, g_aps.at(i));
    }
    j += "]}";

    int code = 0;
    if (postJson(j, code)) sent++;
    res.last_http_code = code;

    if (total == 0) break;                 // still report an empty capture
  }

  res.batches_sent = sent;
  res.ok = (sent == res.batches_total);

  WiFi.disconnect(false, false);
  return res;
}
