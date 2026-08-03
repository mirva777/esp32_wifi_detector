// sniffer.h — drives one full capture pass over the 2.4 GHz band.
#pragma once

#include <stdint.h>

struct SniffStats {
  uint16_t frames_captured;
  uint16_t frames_dropped;   // queue overflow
  uint16_t scan_records;     // APs returned by the driver's own scan
  uint32_t duration_ms;
};

// Runs an active scan (for driver-supplied metadata) followed by promiscuous
// channel hopping (for full information-element harvesting), merging both into
// g_aps. Leaves the radio in station mode, disconnected and out of promiscuous
// mode, ready for the uplink.
SniffStats runCapture();
