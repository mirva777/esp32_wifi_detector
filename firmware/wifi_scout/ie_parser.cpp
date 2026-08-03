#include "ie_parser.h"
#include <string.h>
#include <esp_wifi_types.h>

// ---------------------------------------------------------------------------
// Element IDs (IEEE 802.11-2020 Table 9-92)
// ---------------------------------------------------------------------------
enum : uint8_t {
  EID_SSID              = 0,
  EID_SUPP_RATES        = 1,
  EID_DS_PARAMS         = 3,
  EID_TIM               = 5,
  EID_COUNTRY           = 7,
  EID_BSS_LOAD          = 11,
  EID_RSN               = 48,
  EID_EXT_SUPP_RATES    = 50,
  EID_MOBILITY_DOMAIN   = 54,
  EID_HT_CAPS           = 45,
  EID_HT_OPERATION      = 61,
  EID_RM_ENABLED_CAPS   = 70,
  EID_EXT_CAPS          = 127,
  EID_VHT_CAPS          = 191,
  EID_VHT_OPERATION     = 192,
  EID_VENDOR_SPECIFIC   = 221,
  EID_EXTENSION         = 255,
};

// Element ID Extension values carried inside EID_EXTENSION.
enum : uint8_t {
  EXT_HE_CAPABILITIES  = 35,
  EXT_HE_OPERATION     = 36,
  EXT_EHT_OPERATION    = 106,
  EXT_EHT_CAPABILITIES = 108,
};

static const uint8_t OUI_MICROSOFT[3] = {0x00, 0x50, 0xF2};
static const uint8_t OUI_RSN[3]       = {0x00, 0x0F, 0xAC};

// AKM suite selector types under OUI 00:0F:AC.
enum : uint8_t {
  AKM_8021X          = 1,
  AKM_PSK            = 2,
  AKM_FT_8021X       = 3,
  AKM_FT_PSK         = 4,
  AKM_8021X_SHA256   = 5,
  AKM_PSK_SHA256     = 6,
  AKM_SAE            = 8,
  AKM_FT_SAE         = 9,
  AKM_8021X_SUITEB   = 11,
  AKM_8021X_SUITEB192= 12,
  AKM_FT_8021X_384   = 13,
  AKM_OWE            = 18,
  AKM_SAE_EXT_KEY    = 24,
  AKM_FT_SAE_EXT_KEY = 25,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
static inline uint16_t rd16le(const uint8_t* p) {
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}
static inline uint16_t rd16be(const uint8_t* p) {
  return ((uint16_t)p[0] << 8) | (uint16_t)p[1];
}
static inline uint64_t rd64le(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

// Copy an untrusted, non-NUL-terminated field into a fixed buffer as printable
// ASCII. Keeps control bytes and quotes out of the JSON we later emit.
static void copyPrintable(char* dst, size_t dstSize, const uint8_t* src, size_t n) {
  size_t out = 0;
  const size_t cap = dstSize - 1;
  for (size_t i = 0; i < n && out < cap; i++) {
    uint8_t c = src[i];
    if (c >= 0x20 && c < 0x7F) dst[out++] = (char)c;
  }
  dst[out] = '\0';
}

const char* authModeName(uint8_t mode) {
  switch (mode) {
    case WIFI_AUTH_OPEN:            return "OPEN";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2-PSK";
    case WIFI_AUTH_ENTERPRISE:      return "WPA2-Enterprise";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3-SAE";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/WPA3-PSK";
    case WIFI_AUTH_WAPI_PSK:        return "WAPI-PSK";
    case WIFI_AUTH_OWE:             return "OWE";
    default:                        return "UNKNOWN";
  }
}

const char* cipherName(uint8_t suite) {
  switch (suite) {
    case 0:  return "GROUP";
    case 1:  return "WEP-40";
    case 2:  return "TKIP";
    case 4:  return "CCMP-128";
    case 5:  return "WEP-104";
    case 6:  return "BIP-CMAC-128";
    case 8:  return "GCMP-128";
    case 9:  return "GCMP-256";
    case 10: return "CCMP-256";
    case 11: return "BIP-GMAC-128";
    case 12: return "BIP-GMAC-256";
    case 13: return "BIP-CMAC-256";
    default: return "UNKNOWN";
  }
}

// WPS primary device type, category portion (WSC spec Table 41).
const char* wpsCategoryName(uint16_t cat) {
  switch (cat) {
    case 1:  return "Computer";
    case 2:  return "Input Device";
    case 3:  return "Printer/Scanner";
    case 4:  return "Camera";
    case 5:  return "Storage";
    case 6:  return "Network Infrastructure";
    case 7:  return "Display";
    case 8:  return "Multimedia Device";
    case 9:  return "Gaming Device";
    case 10: return "Telephone";
    case 11: return "Audio Device";
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Peak PHY rate estimate, per spatial stream, in Mbps (short guard interval).
// ---------------------------------------------------------------------------
static uint16_t perStreamRate(const ApRecord* r) {
  uint16_t bw = r->bandwidth_mhz;
  if (r->phy_11ax || r->phy_11be) {          // HE/EHT, MCS11, 0.8 us GI
    if (bw >= 160) return 1201;
    if (bw >= 80)  return 600;
    if (bw >= 40)  return 287;
    return 143;
  }
  if (r->phy_11ac) {                          // VHT, MCS9, short GI
    if (bw >= 160) return 867;
    if (bw >= 80)  return 433;
    if (bw >= 40)  return 200;
    return 87;
  }
  if (r->phy_11n) {                           // HT, MCS7, short GI
    if (bw >= 40) return 150;
    return 72;
  }
  if (r->phy_11g) return 54;
  if (r->phy_11b) return 11;
  return 0;
}

static void recomputeRate(ApRecord* r) {
  uint8_t ss = r->spatial_streams ? r->spatial_streams : 1;
  uint32_t total = (uint32_t)perStreamRate(r) * ss;
  r->max_rate_mbps = (total > 65535) ? 65535 : (uint16_t)total;
}

// ---------------------------------------------------------------------------
// RSN / WPA element
// ---------------------------------------------------------------------------
// `isRsn` selects the OUI to expect (00:0F:AC for RSN, 00:50:F2 for WPA1) and
// whether trailing RSN capabilities are present.
static void parseRsnLike(ApRecord* r, const uint8_t* d, uint8_t len, bool isRsn) {
  if (len < 2) return;
  const uint8_t* expectOui = isRsn ? OUI_RSN : OUI_MICROSOFT;
  uint8_t p = 2;                                    // skip version

  if (len >= p + 4) {                               // group cipher suite
    if (memcmp(d + p, expectOui, 3) == 0) r->group_cipher = d[p + 3];
    p += 4;
  }

  if (len >= p + 2) {                               // pairwise cipher suites
    uint16_t n = rd16le(d + p);
    p += 2;
    if (n > 8) return;                              // implausible, bail out
    for (uint16_t i = 0; i < n && len >= p + 4; i++, p += 4) {
      if (memcmp(d + p, expectOui, 3) == 0) {
        uint8_t suite = d[p + 3];
        // Report the strongest pairwise cipher offered.
        if (suite > r->pairwise_cipher || r->pairwise_cipher == 0) {
          r->pairwise_cipher = suite;
        }
      }
    }
  }

  if (len >= p + 2) {                               // AKM suites
    uint16_t n = rd16le(d + p);
    p += 2;
    if (n > 8) return;
    for (uint16_t i = 0; i < n && len >= p + 4; i++, p += 4) {
      if (memcmp(d + p, expectOui, 3) != 0) continue;
      switch (d[p + 3]) {
        case AKM_PSK:
        case AKM_PSK_SHA256:      r->akm_psk = true; break;
        case AKM_FT_PSK:          r->akm_psk = true; r->akm_ft = true; break;
        case AKM_SAE:
        case AKM_SAE_EXT_KEY:     r->akm_sae = true; r->wpa3 = true; break;
        case AKM_FT_SAE:
        case AKM_FT_SAE_EXT_KEY:  r->akm_sae = true; r->wpa3 = true;
                                  r->akm_ft = true; break;
        case AKM_8021X:
        case AKM_8021X_SHA256:    r->akm_8021x = true; break;
        case AKM_FT_8021X:
        case AKM_FT_8021X_384:    r->akm_8021x = true; r->akm_ft = true; break;
        case AKM_8021X_SUITEB:
        case AKM_8021X_SUITEB192: r->akm_8021x = true; r->akm_suiteb = true;
                                  r->wpa3 = true; break;
        case AKM_OWE:             r->owe = true; r->wpa3 = true; break;
        default: break;
      }
    }
  }

  if (isRsn) {
    r->wpa2 = true;
    if (len >= p + 2) {                             // RSN capabilities
      uint16_t caps = rd16le(d + p);
      r->pmf_required = (caps & 0x0040) != 0;       // MFPR
      r->pmf_capable  = (caps & 0x0080) != 0;       // MFPC
    }
  } else {
    r->wpa1 = true;
  }
}

// ---------------------------------------------------------------------------
// WPS element (OUI 00:50:F2, type 4). Attributes are big-endian TLVs and carry
// the router's self-reported manufacturer / model strings.
// ---------------------------------------------------------------------------
static void parseWps(ApRecord* r, const uint8_t* d, uint8_t len) {
  r->wps_active = true;
  uint16_t p = 0;
  while (p + 4 <= len) {
    uint16_t type = rd16be(d + p);
    uint16_t alen = rd16be(d + p + 2);
    p += 4;
    if (p + alen > len) break;                      // truncated attribute
    const uint8_t* v = d + p;

    switch (type) {
      case 0x1011: copyPrintable(r->wps_device_name,  sizeof r->wps_device_name,  v, alen); break;
      case 0x1021: copyPrintable(r->wps_manufacturer, sizeof r->wps_manufacturer, v, alen); break;
      case 0x1023: copyPrintable(r->wps_model_name,   sizeof r->wps_model_name,   v, alen); break;
      case 0x1024: copyPrintable(r->wps_model_number, sizeof r->wps_model_number, v, alen); break;
      case 0x1042: copyPrintable(r->wps_serial,       sizeof r->wps_serial,       v, alen); break;
      case 0x1044: if (alen >= 1) r->wps_state = v[0]; break;
      case 0x1047: if (alen >= 16) { memcpy(r->wps_uuid, v, 16); r->has_uuid = true; } break;
      case 0x1054: if (alen >= 8)  r->wps_primary_cat = rd16be(v); break;
      default: break;
    }
    p += alen;
  }
}

// ---------------------------------------------------------------------------
// Vendor-specific element dispatch
// ---------------------------------------------------------------------------
static void noteVendorOui(ApRecord* r, const uint8_t* oui) {
  for (uint8_t i = 0; i < r->vendor_oui_count; i++) {
    if (memcmp(r->vendor_ouis[i], oui, 3) == 0) return;
  }
  if (r->vendor_oui_count < 8) {
    memcpy(r->vendor_ouis[r->vendor_oui_count++], oui, 3);
  }
}

static void parseVendor(ApRecord* r, const uint8_t* d, uint8_t len) {
  if (len < 4) return;
  const uint8_t* oui = d;
  uint8_t type = d[3];

  if (memcmp(oui, OUI_MICROSOFT, 3) == 0) {
    if (type == 0x01)      parseRsnLike(r, d + 4, len - 4, false);  // WPA1
    else if (type == 0x04) parseWps(r, d + 4, len - 4);             // WPS
    // type 0x02 is WMM/WME — no data we surface.
    return;
  }
  noteVendorOui(r, oui);
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
static void parseRates(ApRecord* r, const uint8_t* d, uint8_t len) {
  for (uint8_t i = 0; i < len; i++) {
    uint8_t half = d[i] & 0x7F;                     // units of 500 kbps
    if (half == 2 || half == 4 || half == 11 || half == 22) {
      r->phy_11b = true;                            // DSSS/CCK: 1/2/5.5/11
    } else if (half > 22) {
      r->phy_11g = true;                            // OFDM rates
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
void parseManagementFrame(const uint8_t* frame, uint16_t len, int8_t rssi,
                          uint8_t rx_channel) {
  // 24 B MAC header + 12 B fixed params + at least one IE header.
  if (len < 38) return;

  uint8_t ftype   = (frame[0] >> 2) & 0x03;
  uint8_t subtype = (frame[0] >> 4) & 0x0F;
  if (ftype != 0x00) return;                        // management frames only
  if (subtype != SUBTYPE_BEACON && subtype != SUBTYPE_PROBE_RESP) return;

  const uint8_t* bssid = frame + 16;                // addr3
  ApRecord* r = g_aps.findOrCreate(bssid);
  if (!r) return;                                   // table full

  if (subtype == SUBTYPE_BEACON) r->beacons++;
  else                           r->probe_resps++;

  r->last_seen_ms = millis();
  r->rssi_last    = rssi;
  if (rssi > r->rssi_best) r->rssi_best = rssi;
  if (r->channel == 0) r->channel = rx_channel;

  // --- fixed beacon/probe-response parameters ------------------------------
  r->tsf             = rd64le(frame + 24);
  r->beacon_interval = rd16le(frame + 32);
  r->capability      = rd16le(frame + 34);
  r->privacy         = (r->capability & 0x0010) != 0;

  // --- tagged information elements -----------------------------------------
  uint16_t p = 36;
  while (p + 2 <= len) {
    uint8_t eid   = frame[p];
    uint8_t elen  = frame[p + 1];
    const uint8_t* d = frame + p + 2;
    if (p + 2 + elen > len) break;                  // truncated element

    switch (eid) {
      case EID_SSID:
        if (elen == 0) {
          r->hidden = true;
        } else if (r->ssid_len == 0) {
          bool allNul = true;
          for (uint8_t i = 0; i < elen; i++) if (d[i]) { allNul = false; break; }
          if (allNul) {
            r->hidden = true;
          } else {
            uint8_t n = (elen > 32) ? 32 : elen;
            memcpy(r->ssid_raw, d, n);
            r->ssid_len = n;
            copyPrintable(r->ssid, sizeof r->ssid, d, n);
          }
        }
        break;

      case EID_SUPP_RATES:
      case EID_EXT_SUPP_RATES:
        parseRates(r, d, elen);
        break;

      case EID_DS_PARAMS:
        if (elen >= 1 && d[0] >= 1 && d[0] <= 14) r->channel = d[0];
        break;

      case EID_TIM:
        if (elen >= 2) r->dtim_period = d[1];
        break;

      case EID_COUNTRY:
        if (elen >= 3) {
          r->country[0] = (char)d[0];
          r->country[1] = (char)d[1];
          r->country[2] = '\0';
          r->has_country = true;
          if (elen >= 6) r->max_tx_power = (int8_t)d[5];   // first triplet
        }
        break;

      case EID_BSS_LOAD:                            // 802.11e QBSS Load
        if (elen >= 5) {
          r->has_qbss      = true;
          r->station_count = rd16le(d);
          r->channel_util  = d[2];
        }
        break;

      case EID_RSN:
        parseRsnLike(r, d, elen, true);
        break;

      case EID_MOBILITY_DOMAIN:
        r->ft_11r = true;
        break;

      case EID_RM_ENABLED_CAPS:
        r->rrm_11k = true;
        break;

      case EID_EXT_CAPS:
        // BSS Transition Management is bit 19 -> byte 2, bit 3.
        if (elen >= 3 && (d[2] & 0x08)) r->btm_11v = true;
        break;

      case EID_HT_CAPS:
        if (elen >= 19) {
          r->phy_11n = true;
          uint16_t htcap = rd16le(d);
          if (htcap & 0x0002) {                     // 20/40 MHz capable
            if (r->bandwidth_mhz < 40) r->bandwidth_mhz = 40;
          }
          // Rx MCS bitmap: one byte per spatial stream, MCS 0-7 each.
          uint8_t ss = 0;
          for (uint8_t i = 0; i < 4; i++) if (d[3 + i]) ss++;
          if (ss > r->spatial_streams) r->spatial_streams = ss;
        }
        break;

      case EID_HT_OPERATION:
        if (elen >= 2) {
          if (d[0] >= 1 && d[0] <= 14) r->channel = d[0];
          uint8_t off = d[1] & 0x03;
          if (off == 1)      r->sec_chan_offset = +1;
          else if (off == 3) r->sec_chan_offset = -1;
          else               r->sec_chan_offset = 0;
          if ((d[1] & 0x04) && r->sec_chan_offset != 0) {
            if (r->bandwidth_mhz < 40) r->bandwidth_mhz = 40;
          }
        }
        break;

      case EID_VHT_CAPS:
        if (elen >= 12) {
          r->phy_11ac = true;
          if (r->bandwidth_mhz < 80) r->bandwidth_mhz = 80;
          uint8_t widthSet = (d[0] >> 2) & 0x03;
          if (widthSet >= 1) r->bandwidth_mhz = 160;
          // Rx MCS map: 2 bits per stream, value 3 == unsupported.
          uint16_t mcsMap = rd16le(d + 4);
          uint8_t ss = 0;
          for (uint8_t i = 0; i < 8; i++) {
            if (((mcsMap >> (i * 2)) & 0x03) != 0x03) ss++;
          }
          if (ss > r->spatial_streams) r->spatial_streams = ss;
        }
        break;

      case EID_VHT_OPERATION:
        if (elen >= 3) {
          uint8_t cw = d[0];
          if (cw == 1 && r->bandwidth_mhz < 80)  r->bandwidth_mhz = 80;
          if (cw >= 2 && r->bandwidth_mhz < 160) r->bandwidth_mhz = 160;
        }
        break;

      case EID_EXTENSION:
        if (elen >= 1) {
          switch (d[0]) {
            case EXT_HE_CAPABILITIES:
            case EXT_HE_OPERATION:
              r->phy_11ax = true;
              break;
            case EXT_EHT_CAPABILITIES:
            case EXT_EHT_OPERATION:
              r->phy_11be = true;
              r->phy_11ax = true;                   // EHT implies HE
              break;
            default: break;
          }
        }
        break;

      case EID_VENDOR_SPECIFIC:
        parseVendor(r, d, elen);
        break;

      default:
        break;
    }
    p += 2 + elen;
  }

  // WEP: privacy bit set but neither RSN nor WPA1 element present.
  r->wep  = r->privacy && !r->wpa1 && !r->wpa2;

  // A dual-band AP advertises its VHT/HE capabilities in the 2.4 GHz beacon
  // too, but 802.11 only allows 20 or 40 MHz down here. Keep the generation
  // flags — they describe the hardware — while clamping the operating width to
  // what this channel can actually carry, so the rate estimate stays honest.
  if (r->channel >= 1 && r->channel <= 14 && r->bandwidth_mhz > 40) {
    r->bandwidth_mhz = (r->sec_chan_offset != 0) ? 40 : 20;
  }

  recomputeRate(r);
}
