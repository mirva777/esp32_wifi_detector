#include "sniffer.h"
#include "config.h"
#include "ap_table.h"
#include "ie_parser.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <string.h>

// ---------------------------------------------------------------------------
// Promiscuous capture -> parser hand-off
// ---------------------------------------------------------------------------
struct RawPkt {
  uint16_t len;
  int8_t   rssi;
  uint8_t  channel;
  uint8_t  data[PKT_MAX_LEN];
};

static QueueHandle_t s_queue    = nullptr;
static volatile uint16_t s_captured = 0;
static volatile uint16_t s_dropped  = 0;

// Called on the WiFi task, not in ISR context. Keep it to a copy and a queue
// push — all decoding happens on the caller's task in drainQueue().
static void promiscuousCb(void* buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT || !s_queue) return;

  const wifi_promiscuous_pkt_t* pkt = (const wifi_promiscuous_pkt_t*)buf;
  int32_t len = pkt->rx_ctrl.sig_len;
  if (len < 4) return;
  len -= 4;                                  // strip the trailing FCS
  if (len > PKT_MAX_LEN) len = PKT_MAX_LEN;

  // Static rather than stack: this callback has a single caller task, and the
  // WiFi task's stack has no room to spare for a 512-byte frame copy.
  static RawPkt item;
  item.len     = (uint16_t)len;
  item.rssi    = pkt->rx_ctrl.rssi;
  item.channel = pkt->rx_ctrl.channel;
  memcpy(item.data, pkt->payload, len);

  if (xQueueSend(s_queue, &item, 0) == pdTRUE) s_captured++;
  else                                         s_dropped++;
}

static void drainQueue() {
  static RawPkt item;
  while (s_queue && xQueueReceive(s_queue, &item, 0) == pdTRUE) {
    parseManagementFrame(item.data, item.len, item.rssi, item.channel);
  }
}

// Dwell on the current channel, decoding frames as they arrive so the queue
// never has to hold more than a couple of milliseconds of traffic.
static void dwell(uint32_t ms) {
  uint32_t end = millis() + ms;
  while ((int32_t)(end - millis()) > 0) {
    drainQueue();
    delay(2);
  }
  drainQueue();
}

// ---------------------------------------------------------------------------
// Broadcast probe request
// ---------------------------------------------------------------------------
// Soliciting probe responses matters because many routers put the WPS element
// (manufacturer / model strings) only in probe responses, not in beacons. This
// is the same wildcard probe any phone emits while scanning.
static uint8_t s_probeReq[] = {
  0x40, 0x00,                          // frame control: mgmt, probe request
  0x00, 0x00,                          // duration
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff,  // addr1: broadcast
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // addr2: our MAC, filled in at runtime
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff,  // addr3: broadcast BSSID
  0x00, 0x00,                          // sequence control
  0x00, 0x00,                          // SSID element, length 0 (wildcard)
  0x01, 0x04, 0x02, 0x04, 0x0b, 0x16   // supported rates: 1, 2, 5.5, 11 Mbps
};

static void initProbeTemplate() {
  uint8_t mac[6];
  esp_wifi_get_mac(WIFI_IF_STA, mac);
  memcpy(s_probeReq + 10, mac, 6);
}

static void sendProbeRequests() {
  for (int i = 0; i < PROBE_PER_CHANNEL; i++) {
    // Failures here are non-fatal: we still collect beacons either way.
    esp_wifi_80211_tx(WIFI_IF_STA, s_probeReq, sizeof(s_probeReq), false);
    delay(5);
  }
}

// ---------------------------------------------------------------------------
// Driver scan -> table merge
// ---------------------------------------------------------------------------
// The driver's scan gives us a few things the beacon parser cannot: the
// negotiated auth mode, the FTM flags, and a definitive "this AP is really
// here" signal independent of our own IE decoding.
static uint16_t mergeScanResults() {
  uint16_t num = 0;
  if (esp_wifi_scan_get_ap_num(&num) != ESP_OK || num == 0) return 0;
  if (num > MAX_APS) num = MAX_APS;

  wifi_ap_record_t* recs =
      (wifi_ap_record_t*)malloc((size_t)num * sizeof(wifi_ap_record_t));
  if (!recs) return 0;

  if (esp_wifi_scan_get_ap_records(&num, recs) != ESP_OK) {
    free(recs);
    return 0;
  }

  for (uint16_t i = 0; i < num; i++) {
    const wifi_ap_record_t& a = recs[i];
    ApRecord* r = g_aps.findOrCreate(a.bssid);
    if (!r) continue;

    r->seen_in_scan = true;
    r->authmode     = (uint8_t)a.authmode;
    if (a.rssi > r->rssi_best) r->rssi_best = a.rssi;
    if (r->rssi_last == -128)  r->rssi_last = a.rssi;
    if (r->channel == 0)       r->channel   = a.primary;

    if (r->ssid_len == 0 && a.ssid[0] != '\0') {
      size_t n = strnlen((const char*)a.ssid, 32);
      memcpy(r->ssid_raw, a.ssid, n);
      r->ssid_len = (uint8_t)n;
      strncpy(r->ssid, (const char*)a.ssid, sizeof(r->ssid) - 1);
      r->ssid[sizeof(r->ssid) - 1] = '\0';
    }
    if (a.ssid[0] == '\0') r->hidden = true;

    if (r->sec_chan_offset == 0) {
      if (a.second == WIFI_SECOND_CHAN_ABOVE)      r->sec_chan_offset = +1;
      else if (a.second == WIFI_SECOND_CHAN_BELOW) r->sec_chan_offset = -1;
    }

    // The IE parser is more precise about PHY generation, so only fill gaps.
    if (a.phy_11b)  r->phy_11b  = true;
    if (a.phy_11g)  r->phy_11g  = true;
    if (a.phy_11n)  r->phy_11n  = true;
    if (a.phy_11ac) r->phy_11ac = true;
    if (a.phy_11ax) r->phy_11ax = true;
    if (a.phy_lr)   r->phy_lr   = true;
    if (a.wps)      r->wps_active = true;

    r->ftm_responder = a.ftm_responder;
    r->ftm_initiator = a.ftm_initiator;

    if (!r->has_country && a.country.cc[0]) {
      r->country[0]     = a.country.cc[0];
      r->country[1]     = a.country.cc[1];
      r->country[2]     = '\0';
      r->has_country    = true;
      r->max_tx_power   = a.country.max_tx_power;
      r->country_schan  = a.country.schan;
      r->country_nchan  = a.country.nchan;
    }
  }

  free(recs);
  esp_wifi_scan_stop();
  return num;
}

// ---------------------------------------------------------------------------
// Capture pass
// ---------------------------------------------------------------------------
SniffStats runCapture() {
  SniffStats st = {};
  uint32_t t0   = millis();

  s_captured = 0;
  s_dropped  = 0;
  g_aps.clear();

  // Radio into a clean, unassociated station state.
  WiFi.setAutoReconnect(false);
  WiFi.persistent(false);
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  delay(100);

  // --- phase 1: driver active scan ----------------------------------------
  wifi_scan_config_t cfg = {};
  cfg.show_hidden          = true;
  cfg.scan_type            = WIFI_SCAN_TYPE_ACTIVE;
  cfg.scan_time.active.min = 120;
  cfg.scan_time.active.max = 300;

  if (esp_wifi_scan_start(&cfg, true) == ESP_OK) {
    st.scan_records = mergeScanResults();
  }

  // --- phase 2: promiscuous IE harvest ------------------------------------
  if (!s_queue) {
    s_queue = xQueueCreate(PKT_QUEUE_DEPTH, sizeof(RawPkt));
    if (!s_queue) {                       // out of memory: scan data only
      st.duration_ms = millis() - t0;
      return st;
    }
  }
  xQueueReset(s_queue);

  initProbeTemplate();

  wifi_promiscuous_filter_t filter = {};
  filter.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT;
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(promiscuousCb);
  esp_wifi_set_promiscuous(true);

  for (int round = 0; round < HOP_ROUNDS; round++) {
    for (uint8_t ch = CHAN_MIN; ch <= CHAN_MAX; ch++) {
      esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
      delay(5);                            // let the PLL settle
      sendProbeRequests();
      dwell(HOP_DWELL_MS);
    }
  }

  esp_wifi_set_promiscuous(false);
  esp_wifi_set_promiscuous_rx_cb(nullptr);
  drainQueue();

  st.frames_captured = s_captured;
  st.frames_dropped  = s_dropped;
  st.duration_ms     = millis() - t0;
  return st;
}
