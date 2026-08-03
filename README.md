# WiFi Scout

An ESP32 that surveys the Wi-Fi access points around it and streams what it finds
to a web dashboard. Plug it into power, and every couple of minutes it sweeps the
2.4 GHz band, decodes every beacon and probe response it hears, joins your
hotspot, and uploads the results.

Everything it records is information routers broadcast publicly to any device in
range — the same frames your phone reads to draw its Wi-Fi list. It never
associates with them, never sends traffic at them, and never attempts
authentication.

---

## What it collects

Most tools stop at SSID, signal, and channel. This decodes the full information
elements in each beacon, which is where the interesting data lives.

**Identity**
- SSID (raw bytes preserved, so non-Latin names survive), hidden-network flag
- BSSID, and the vendor that registered that MAC block
- **Router manufacturer, model name, model number, serial and device name**, read
  from the WPS element — this is the actual make and model, self-reported by the
  router
- WPS UUID and primary device type

**Radio**
- Signal (best and most recent), primary channel, secondary-channel offset
- Operating bandwidth, spatial streams, estimated peak PHY rate
- Wi-Fi generation: 802.11b/g through Wi-Fi 4/5/6/7, from the HT/VHT/HE/EHT elements
- Beacon interval, DTIM period

**Security**
- Auth mode, and the decoded RSN element: WEP / WPA / WPA2 / WPA3 / OWE
- AKM suites — PSK, SAE, 802.1X, fast-transition, Suite-B
- Pairwise and group ciphers (TKIP, CCMP-128, GCMP-256, …)
- Protected Management Frames: capable vs required
- WPS enabled, and whether it is in the unconfigured state

**Load and health**
- **Number of clients currently associated**, and channel utilisation, from the
  QBSS Load element the AP publishes itself
- **Time since the AP last rebooted**, derived from its TSF timer
- Country code, regulatory channel range, max permitted TX power

**Roaming**
- 802.11k radio measurement, 802.11v BSS transition, 802.11r fast roaming
- 802.11mc FTM ranging support
- Vendor-specific element OUIs, useful for fingerprinting enterprise gear

Plus per-AP history: first seen, last seen, times observed, and an RSSI chart.

### Real output from the hardware

```
  22:e8:29:09:7e:40  ch6    -54 dBm  WPA2/WPA3-PSK   A-004
      Wi-Fi 4  20 MHz  3ss  216 Mbps  beacon 16/probe 14  up 2d0h  clients 0 (33%)  US  PMF  11k  11v
  e0:da:90:69:d1:c2  ch11   -58 dBm  WPA3-SAE        UWED Guest
      Wi-Fi 6  20 MHz  2ss  286 Mbps  beacon 6/probe 7   up 2d0h  clients 0 (10%)  UZ  PMF-req  11k  11v
```

---

## Hardware

- Any classic ESP32 dev board (tested on an ESP32-D0WD-V3 DevKit with a CP2102).
- A **data** USB cable — charge-only cables are the most common reason a board
  never appears as a serial port.
- Any USB power source for standalone running.

**The classic ESP32 has a 2.4 GHz radio only.** It cannot see 5 GHz or 6 GHz
networks — those simply will not appear. A dual-band AP still shows up via its
2.4 GHz radio, and its beacon usually reveals the 5 GHz capabilities too.

---

## Quick start

### 1. Try it locally first (no hardware, no deploy)

```bash
npm run server
```

Then in another terminal, feed it a realistic fake capture:

```bash
npm run simulate
```

Open <http://localhost:8080>. This exercises the exact ingest path the ESP32
uses, so it is the fastest way to see the dashboard working.

### 2. Flash the ESP32

Requires `arduino-cli` (`brew install arduino-cli`) and the ESP32 core:

```bash
arduino-cli core install esp32:esp32
```

Then:

```bash
npm run flash
```

Watch it work:

```bash
npm run monitor
```

On first boot with no configuration stored, it runs one scan and prints
everything it found to the serial console, then starts the setup portal. That
scan is your proof the radio works before any network is involved.

### 3. Configure the device

The device starts a Wi-Fi network called **`WiFiScout-XXXX`**, password
`scout1234`. Join it from your phone and the setup page opens automatically; if
it does not, browse to <http://192.168.4.1>.

Fill in your hotspot name and password, the dashboard URL, and the upload token,
then save. It reboots and starts reporting.

To change any of this later, hold the **BOOT** button for 3 seconds while
powering on — that clears the stored config and returns to the portal. No
reflashing needed.

> Your hotspot must be **2.4 GHz**. On iPhone, enable *Settings → Personal
> Hotspot → Maximise Compatibility*; otherwise the ESP32 cannot see it.

---

## Deploying the dashboard to Vercel

### 1. Create the database

In the Vercel dashboard: **Storage → Create Database → Neon (Postgres)**, and
connect it to your project. Vercel injects `DATABASE_URL` automatically. The
schema is created on the first request — there is no migration step.

### 2. Set the upload token

The ingest endpoint is public, so it is protected by a shared secret. Generate
one:

```bash
openssl rand -hex 24
```

In **Project Settings → Environment Variables**, add it as `SCOUT_TOKEN` for all
environments. Put the same value into the device's setup portal.

Without `SCOUT_TOKEN` set, ingest returns 503 and refuses to store anything —
the endpoint is never unauthenticated by accident.

### 3. Deploy

Set the project's **Root Directory** to `web`, then deploy:

```bash
cd web && vercel --prod
```

or push to a connected Git repository.

### 4. Verify before touching the hardware

```bash
node tools/simulate.mjs https://your-project.vercel.app --token YOUR_TOKEN
```

If that populates the dashboard, the device will too.

### Optional: full vendor database

The dashboard ships with a curated table of ~170 common router vendors. For the
complete IEEE registry (~35,000 entries):

```bash
npm run fetch-oui
```

That writes `web/lib/oui-data.js` — commit it so Vercel bundles it. Router
make and model from the WPS element does not depend on this.

---

## A note on the dashboard being public

Anything deployed to Vercel is reachable by anyone with the URL. The token
protects *writes* (ingest and purge), not reads. If the survey data is sensitive,
put the deployment behind Vercel Authentication (**Project Settings →
Deployment Protection**).

---

## Project layout

```
firmware/wifi_scout/     ESP32 firmware
  wifi_scout.ino           boot, capture/upload cycle
  sniffer.cpp              active scan + promiscuous channel hopping
  ie_parser.cpp            802.11 information-element decoder
  ap_table.cpp             fixed-capacity AP table
  uploader.cpp             JSON serialisation and HTTPS upload
  portal.cpp               captive-portal configuration
  settings.cpp             NVS-backed config
  config.h                 tunables

web/                     Vercel deployment
  api/                     serverless endpoints
  lib/                     Postgres access, vendor lookup, helpers
  public/                  the dashboard (shared with the local server)

server/                  local test server: same API, SQLite, zero npm deps
tools/                   flash.sh, monitor.sh, simulate.mjs, fetch-oui.mjs
```

---

## How the capture works

Staying joined to a hotspot pins the radio to one channel, so the device
alternates between two modes.

1. **Capture.** Unassociated. First a driver-level active scan collects the auth
   mode and FTM flags. Then promiscuous mode sweeps channels 1–13 three times,
   dwelling ~180 ms each — long enough to catch beacons, which arrive about every
   100 ms. On each channel it also emits a wildcard probe request, because many
   routers include the WPS element (the make and model) only in probe responses.
   Captured frames go through a queue to a decoder that bounds-checks every
   field, so a malformed beacon cannot crash the device.

2. **Upload.** Joins your hotspot, syncs the clock over NTP, POSTs the table in
   batches of 12, disconnects, and idles until the next cycle.

Tunables live in `firmware/wifi_scout/config.h` — scan interval, dwell time,
channel range, batch size, max APs tracked (96 by default, ~24 KB).

### LED

| Pattern | Meaning |
|---|---|
| Solid | Capture in progress |
| Slow blink | Waiting in the setup portal |
| 2 quick blinks | Upload succeeded |
| 5 quick blinks | Upload failed — retries next cycle |

---

## Troubleshooting

**No serial port / `npm run flash` finds nothing.** Check `ls /dev/cu.*` for a
`cu.usbserial-*` or `cu.SLAB_USBtoUART*` entry. If absent: try a different cable
(data, not charge-only), plug directly into the machine rather than a hub, and
try another port. Some boards need the **BOOT** button held during upload.

**Device never joins the hotspot.** It must be 2.4 GHz — see the note above. The
serial console prints the failure and the Wi-Fi status code each cycle.

**Uploads fail with 401.** The token in the portal does not match `SCOUT_TOKEN`.

**Uploads fail with 503.** `SCOUT_TOKEN` is not set on the server.

**No router models appear.** Normal for enterprise access points, which usually
omit the WPS element — the campus APs in the sample output above show none.
Consumer routers generally do advertise it. Vendor is still resolved from the
BSSID either way.

**Fewer networks than your phone shows.** Your phone scans 5 GHz too. Compare
against its 2.4 GHz networks only.

---

## Legal note

Passive reception of publicly broadcast beacon frames is what every Wi-Fi device
does in order to function, and this tool does no more than that. It does not
deauthenticate, inject traffic at other networks, capture handshakes, or attempt
to join anything except the hotspot you configure. Rules on radio monitoring
still vary by jurisdiction — worth a check if you intend to run surveys beyond
your own space.
