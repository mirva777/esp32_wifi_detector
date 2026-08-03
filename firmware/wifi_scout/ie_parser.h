// ie_parser.h — decode 802.11 beacon / probe-response frames into an ApRecord.
#pragma once

#include <stdint.h>
#include "ap_table.h"

// 802.11 management frame subtypes we care about.
#define SUBTYPE_PROBE_RESP 0x05
#define SUBTYPE_BEACON     0x08

// Feed one raw 802.11 frame (no FCS) captured in promiscuous mode. Non-beacon
// and non-probe-response frames are ignored. Every field is bounds-checked, so
// truncated or malformed frames are discarded rather than trusted.
void parseManagementFrame(const uint8_t* frame, uint16_t len, int8_t rssi,
                          uint8_t rx_channel);

// Helpers shared with the uploader.
const char* authModeName(uint8_t mode);
const char* cipherName(uint8_t suite);
const char* wpsCategoryName(uint16_t cat);
