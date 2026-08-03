// config.h — compile-time tunables for WiFi Scout.
#pragma once

#include <stdint.h>

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
#define FW_VERSION        "1.0.0"

// Prefix for the config-portal SoftAP. The device MAC suffix gets appended,
// e.g. "WiFiScout-8F68".
#define PORTAL_AP_PREFIX  "WiFiScout-"
#define PORTAL_AP_PASS    "scout1234"   // >= 8 chars, required by WPA2
#define PORTAL_TIMEOUT_MS 0             // 0 = stay in portal until configured

// ---------------------------------------------------------------------------
// Optional build-time defaults. Leave empty to configure over the captive
// portal instead (recommended — no need to reflash when the hotspot changes).
// ---------------------------------------------------------------------------
#define DEFAULT_WIFI_SSID ""
#define DEFAULT_WIFI_PASS ""
#define DEFAULT_SERVER    ""            // e.g. "https://my-scout.vercel.app"
#define DEFAULT_TOKEN     ""            // must match SCOUT_TOKEN on the server

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
#define MAX_APS           96            // ~250 B each -> ~24 KB static
#define CHAN_MIN          1
#define CHAN_MAX          13            // ESP32 classic is 2.4 GHz only
#define HOP_ROUNDS        3             // passes over the channel list
#define HOP_DWELL_MS      180           // beacons arrive every ~100 ms
#define PROBE_PER_CHANNEL 2             // broadcast probe requests per dwell

// Promiscuous callback -> parser task hand-off.
#define PKT_QUEUE_DEPTH   24
#define PKT_MAX_LEN       512

// ---------------------------------------------------------------------------
// Cycle timing
// ---------------------------------------------------------------------------
#define CYCLE_INTERVAL_MS 120000UL      // full scan+upload cycle period
#define WIFI_CONNECT_MS   25000UL       // join timeout for the uplink
#define UPLOAD_BATCH      12            // APs per HTTP POST (TLS needs heap too)
#define HTTP_TIMEOUT_MS   15000

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------
#define LED_PIN           2             // onboard LED on most DevKit boards
#define BOOT_BTN_PIN      0             // hold at boot to wipe stored config
#define BOOT_BTN_HOLD_MS  3000

#define NTP_SERVER_1      "pool.ntp.org"
#define NTP_SERVER_2      "time.nist.gov"
