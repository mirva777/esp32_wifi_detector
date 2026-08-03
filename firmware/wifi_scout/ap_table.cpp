#include "ap_table.h"
#include <string.h>

ApTable g_aps;

void ApTable::clear() {
  memset(rows_, 0, sizeof(rows_));
  count_   = 0;
  dropped_ = 0;
}

ApRecord* ApTable::find(const uint8_t bssid[6]) {
  for (uint16_t i = 0; i < count_; i++) {
    if (memcmp(rows_[i].bssid, bssid, 6) == 0) return &rows_[i];
  }
  return nullptr;
}

ApRecord* ApTable::findOrCreate(const uint8_t bssid[6]) {
  ApRecord* r = find(bssid);
  if (r) return r;

  if (count_ >= MAX_APS) {
    dropped_++;
    return nullptr;
  }

  r = &rows_[count_++];
  memset(r, 0, sizeof(ApRecord));
  memcpy(r->bssid, bssid, 6);
  r->used          = true;
  r->rssi_best     = -128;
  r->rssi_last     = -128;
  r->first_seen_ms = millis();
  r->last_seen_ms  = r->first_seen_ms;
  r->bandwidth_mhz = 20;
  return r;
}
