// uploader.h — serialise the AP table and POST it to the dashboard.
#pragma once

#include <stdint.h>
#include "sniffer.h"

struct UploadResult {
  bool     ok;
  uint16_t batches_sent;
  uint16_t batches_total;
  int      last_http_code;
};

// Joins the configured network, posts the table in batches, then disconnects.
UploadResult uploadResults(const SniffStats& st, uint32_t seq);
