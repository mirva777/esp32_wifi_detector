// ap_table.h — in-RAM table of observed access points, keyed by BSSID.
#pragma once

#include <Arduino.h>
#include "config.h"

// Everything we can pull out of a beacon / probe response, plus what the
// driver's own scan records give us. Fixed-size fields keep this out of the
// heap so a long run can't fragment memory.
struct ApRecord {
  uint8_t  bssid[6];
  char     ssid[33];         // printable-ASCII rendering, for logs
  uint8_t  ssid_raw[32];     // exact bytes; the server decodes UTF-8 from these
  uint8_t  ssid_len;
  bool     hidden;

  // --- signal / channel ---------------------------------------------------
  int8_t   rssi_best;
  int8_t   rssi_last;
  uint8_t  channel;          // primary channel
  int8_t   sec_chan_offset;  // -1 below, 0 none, +1 above
  uint16_t bandwidth_mhz;    // 20 / 40 / 80 / 160

  // --- beacon fixed fields ------------------------------------------------
  uint64_t tsf;              // AP's 64-bit timer -> uptime since last reboot
  uint16_t beacon_interval;  // in TUs (1 TU = 1024 us)
  uint16_t capability;       // capability info bitfield
  uint8_t  dtim_period;

  // --- regulatory ---------------------------------------------------------
  char     country[4];
  int8_t   max_tx_power;     // dBm, from Country IE
  uint8_t  country_schan;    // first allowed channel
  uint8_t  country_nchan;    // number of allowed channels
  bool     has_country;

  // --- BSS load (11e QBSS) ------------------------------------------------
  bool     has_qbss;
  uint16_t station_count;    // clients the AP reports as associated
  uint8_t  channel_util;     // 0-255, fraction of time the medium is busy

  // --- PHY generation -----------------------------------------------------
  bool     phy_11b, phy_11g, phy_11n, phy_11ac, phy_11ax, phy_11be;
  uint8_t  spatial_streams;
  uint16_t max_rate_mbps;    // estimated PHY peak

  // --- security -----------------------------------------------------------
  uint8_t  authmode;         // wifi_auth_mode_t from the scan record
  bool     privacy;          // capability bit 4
  bool     wep, wpa1, wpa2, wpa3, owe;
  bool     akm_psk, akm_sae, akm_8021x, akm_ft, akm_suiteb;
  uint8_t  group_cipher;     // RSN suite selector type
  uint8_t  pairwise_cipher;
  bool     pmf_capable, pmf_required;

  // --- 802.11 feature flags ----------------------------------------------
  bool     rrm_11k;          // radio measurement
  bool     btm_11v;          // BSS transition management
  bool     ft_11r;           // fast transition (mobility domain IE)
  bool     ftm_responder;    // 802.11mc fine timing measurement
  bool     ftm_initiator;
  bool     phy_lr;           // Espressif long-range proprietary mode
  bool     wps_active;
  uint8_t  wps_state;        // 1 = unconfigured, 2 = configured

  // --- WPS device descriptor: make / model of the router ------------------
  char     wps_manufacturer[33];
  char     wps_model_name[33];
  char     wps_model_number[33];
  char     wps_device_name[33];
  char     wps_serial[17];
  uint16_t wps_primary_cat;
  uint8_t  wps_uuid[16];
  bool     has_uuid;

  // --- vendor-specific IE fingerprints ------------------------------------
  uint8_t  vendor_ouis[8][3];
  uint8_t  vendor_oui_count;

  // --- bookkeeping --------------------------------------------------------
  uint16_t beacons;
  uint16_t probe_resps;
  uint32_t first_seen_ms;
  uint32_t last_seen_ms;
  bool     seen_in_scan;     // also returned by esp_wifi_scan
  bool     used;
};

// Fixed-capacity table. Not thread-safe by itself; all mutation happens on the
// parser task, and reads happen only after capture has stopped.
class ApTable {
 public:
  void       clear();
  ApRecord*  findOrCreate(const uint8_t bssid[6]);
  ApRecord*  find(const uint8_t bssid[6]);
  uint16_t   size() const { return count_; }
  ApRecord*  at(uint16_t i) { return (i < count_) ? &rows_[i] : nullptr; }
  uint16_t   dropped() const { return dropped_; }

 private:
  ApRecord rows_[MAX_APS];
  uint16_t count_   = 0;
  uint16_t dropped_ = 0;   // APs seen after the table filled up
};

extern ApTable g_aps;
