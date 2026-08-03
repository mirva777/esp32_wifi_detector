#!/usr/bin/env node
// simulate.mjs — pretend to be an ESP32 and POST a capture to the dashboard.
//
// Emits exactly the JSON shape firmware/wifi_scout/uploader.cpp produces, so it
// exercises the real ingest path. Useful for checking a Vercel deployment
// before the hardware is flashed, or for developing the dashboard offline.
//
//   node tools/simulate.mjs [url] [--token X] [--count N] [--loop SECONDS]

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const BASE   = (args.find((a) => !a.startsWith('--') &&
                 !args[args.indexOf(a) - 1]?.startsWith('--')) || 'http://localhost:8080')
                 .replace(/\/+$/, '');
const TOKEN  = flag('token', process.env.SCOUT_TOKEN || '');
const COUNT  = Number(flag('count', 16));
const LOOP   = Number(flag('loop', 0));
const BATCH  = 12;

const DEVICE_ID = '14:08:08:9F:8F:68';

// A believable mix: consumer routers that advertise WPS, an ISP box, an
// enterprise AP, a phone hotspot with a randomised MAC, and a hidden network.
const FLEET = [
  { oui: '50:c7:bf', ssid: 'Home-5A2C',        mk: 'TP-LINK',   mdl: 'Archer C6',      num: 'v3.2', gen: 'Wi-Fi 5', ss: 2, bw: 80, sec: 'wpa2' },
  { oui: 'a0:f3:c1', ssid: 'TP-Link_Guest',    mk: 'TP-LINK',   mdl: 'Archer AX23',    num: 'v1.0', gen: 'Wi-Fi 6', ss: 2, bw: 40, sec: 'wpa3t' },
  { oui: '2c:56:dc', ssid: 'ASUS_88',          mk: 'ASUSTeK',   mdl: 'RT-AC58U',       num: '',     gen: 'Wi-Fi 5', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: '44:d9:e7', ssid: 'UniFi-Office',     mk: 'Ubiquiti',  mdl: 'U6-Lite',        num: '',     gen: 'Wi-Fi 6', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: '00:0c:42', ssid: 'MikroTik-3F91',    mk: 'MikroTik',  mdl: 'hAP ac lite',    num: '',     gen: 'Wi-Fi 4', ss: 2, bw: 20, sec: 'wpa2' },
  { oui: '2c:30:33', ssid: 'NETGEAR47',        mk: 'NETGEAR',   mdl: 'R6260',          num: '',     gen: 'Wi-Fi 5', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: '68:a3:78', ssid: 'Livebox-9C10',     mk: 'Sagemcom',  mdl: 'F@st 5657',      num: '',     gen: 'Wi-Fi 5', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: '3c:75:4a', ssid: 'ARRIS-2D40',       mk: 'ARRIS',     mdl: 'TG3452',         num: '',     gen: 'Wi-Fi 5', ss: 3, bw: 80, sec: 'wpa2' },
  { oui: '6c:f3:7f', ssid: 'corp-wifi',        mk: '',          mdl: '',               num: '',     gen: 'Wi-Fi 6', ss: 4, bw: 40, sec: 'ent'  },
  { oui: '14:d6:4d', ssid: 'dlink-4410',       mk: 'D-Link',    mdl: 'DIR-825',        num: 'B1',   gen: 'Wi-Fi 4', ss: 2, bw: 40, sec: 'wpa1' },
  { oui: 'c8:3a:35', ssid: 'Tenda_1F2B04',     mk: 'Tenda',     mdl: 'AC10',           num: '',     gen: 'Wi-Fi 5', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: '78:11:dc', ssid: 'Xiaomi_A4F0',      mk: 'Xiaomi',    mdl: 'Mi Router 4A',   num: '',     gen: 'Wi-Fi 4', ss: 2, bw: 40, sec: 'wpa2' },
  { oui: 'd0:60:8c', ssid: '',                 mk: '',          mdl: '',               num: '',     gen: 'Wi-Fi 4', ss: 1, bw: 20, sec: 'wpa2', hidden: true },
  { oui: 'ae:41:9b', ssid: "Ahror's iPhone",   mk: '',          mdl: '',               num: '',     gen: 'Wi-Fi 5', ss: 1, bw: 20, sec: 'wpa3' },
  { oui: '00:1c:df', ssid: 'FreeCoffeeWiFi',   mk: 'Belkin',    mdl: 'F9K1102',        num: 'v2',   gen: '802.11g', ss: 1, bw: 20, sec: 'open' },
  { oui: '00:17:9a', ssid: 'OldRouter',        mk: 'D-Link',    mdl: 'DIR-300',        num: '',     gen: '802.11g', ss: 1, bw: 20, sec: 'wep'  },
];

const rnd  = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const hex2 = (n) => n.toString(16).padStart(2, '0');

function security(kind) {
  const base = {
    wep: false, wpa1: false, wpa2: false, wpa3: false, owe: false, open: false,
    psk: false, sae: false, dot1x: false, ft: false, suiteb: false,
    pmf_capable: false, pmf_required: false,
    pairwise: 'CCMP-128', group: 'CCMP-128',
  };
  switch (kind) {
    case 'open':  return { ...base, open: true, pairwise: 'UNKNOWN', group: 'UNKNOWN' };
    case 'wep':   return { ...base, wep: true, pairwise: 'WEP-40', group: 'WEP-40' };
    case 'wpa1':  return { ...base, wpa1: true, psk: true, pairwise: 'TKIP', group: 'TKIP' };
    case 'wpa2':  return { ...base, wpa2: true, psk: true };
    case 'wpa3':  return { ...base, wpa2: true, wpa3: true, sae: true,
                           pmf_capable: true, pmf_required: true };
    case 'wpa3t': return { ...base, wpa2: true, wpa3: true, psk: true, sae: true,
                           pmf_capable: true };
    case 'ent':   return { ...base, wpa2: true, dot1x: true, ft: true, pmf_capable: true };
    default:      return base;
  }
}

const AUTH = {
  open: 'OPEN', wep: 'WEP', wpa1: 'WPA-PSK', wpa2: 'WPA2-PSK',
  wpa3: 'WPA3-SAE', wpa3t: 'WPA2/WPA3-PSK', ent: 'WPA2-Enterprise',
};

const PER_STREAM = { 'Wi-Fi 7': 1201, 'Wi-Fi 6': 600, 'Wi-Fi 5': 433, 'Wi-Fi 4': 150, '802.11g': 54, '802.11b': 11 };

// Stable per-BSSID values so repeated runs look like the same physical world.
const seenAt = new Map();

function makeAp(spec, i) {
  // spec.oui supplies the first three octets; derive the last three from the
  // index so the same fleet keeps the same BSSIDs across runs.
  const bssid = `${spec.oui}:${hex2(0x10 + i)}:${hex2((0x40 + i * 7) & 0xff)}:${hex2((0xa0 + i * 13) & 0xff)}`;

  if (!seenAt.has(bssid)) {
    seenAt.set(bssid, {
      rssi: rint(-88, -34),
      channel: [1, 1, 6, 6, 11, 11, 3, 9][i % 8],
      boot: Math.floor(Date.now() / 1000) - rint(3600, 60 * 86400),
    });
  }
  const st = seenAt.get(bssid);
  // Drift the signal a little each pass so the history chart has shape.
  st.rssi = Math.max(-92, Math.min(-30, st.rssi + rint(-3, 3)));

  const gen = spec.gen;
  const ss  = spec.ss;
  const bw  = spec.bw > 40 ? 40 : spec.bw;   // 2.4 GHz caps at 40 MHz
  const perStream = PER_STREAM[gen] || 54;
  const scale = bw >= 40 ? 1 : 0.48;
  const maxMbps = Math.round(perStream * ss * scale);

  const hasWps = !!spec.mk && spec.sec !== 'ent';
  const ssid = spec.hidden ? '' : spec.ssid;

  return {
    bssid,
    ssid: ssid.replace(/[^\x20-\x7e]/g, ''),
    ssid_hex: Buffer.from(ssid, 'utf8').toString('hex'),
    hidden: !!spec.hidden,
    rssi: st.rssi,
    rssi_last: st.rssi - rint(0, 2),
    channel: st.channel,
    sec_chan: bw >= 40 ? (st.channel <= 6 ? 1 : -1) : 0,
    bandwidth: bw,
    auth: AUTH[spec.sec] || 'UNKNOWN',
    security: security(spec.sec),
    phy: {
      b: gen === '802.11b' || gen === '802.11g',
      g: gen !== '802.11b',
      n: ['Wi-Fi 4', 'Wi-Fi 5', 'Wi-Fi 6', 'Wi-Fi 7'].includes(gen),
      ac: ['Wi-Fi 5', 'Wi-Fi 6', 'Wi-Fi 7'].includes(gen),
      ax: ['Wi-Fi 6', 'Wi-Fi 7'].includes(gen),
      be: gen === 'Wi-Fi 7',
      lr: false,
      streams: ss,
      max_mbps: maxMbps,
      generation: gen,
    },
    wps: {
      active: hasWps,
      state: hasWps ? 2 : 0,
      manufacturer: hasWps ? spec.mk : '',
      model_name: hasWps ? spec.mdl : '',
      model_number: hasWps ? spec.num : '',
      device_name: hasWps ? `${spec.mk} ${spec.mdl}`.trim() : '',
      serial: hasWps ? String(rint(10000000, 99999999)) : '',
      category: hasWps ? 'Network Infrastructure' : '',
      uuid: hasWps ? [...Array(16)].map(() => hex2(rint(0, 255))).join('') : '',
    },
    beacon: {
      interval_tu: 100,
      dtim: rint(1, 3),
      capability: 0x0431,
      uptime_s: Math.floor(Date.now() / 1000) - st.boot,
    },
    load: {
      present: hasWps || spec.sec === 'ent',
      stations: rint(0, 12),
      utilization_pct: rint(2, 55),
    },
    country: { code: 'UZ', max_tx_dbm: 20, first_chan: 1, num_chans: 13 },
    features: {
      rrm_11k: spec.sec === 'ent' || gen === 'Wi-Fi 6',
      btm_11v: spec.sec === 'ent' || gen === 'Wi-Fi 6',
      ft_11r: spec.sec === 'ent',
      ftm_responder: gen === 'Wi-Fi 6',
      ftm_initiator: false,
    },
    vendor_ies: ['0050f2', ...(spec.sec === 'ent' ? ['00904c'] : [])],
    stats: {
      beacons: rint(6, 30),
      probe_resps: rint(0, 5),
      in_scan: true,
      observed_ms: rint(2000, 7000),
    },
  };
}

// Each run is a separate process, so a counter starting at 0 would make every
// invocation look like a re-send of capture #1 and the server would collapse
// them into one. Seed from the clock so consecutive runs are distinct captures.
let seq = Math.floor(Date.now() / 1000) % 100000;

async function sendCapture() {
  seq++;
  const specs = FLEET.slice(0, Math.min(COUNT, FLEET.length));
  const aps = specs.map(makeAp);
  const batches = Math.ceil(aps.length / BATCH) || 1;

  console.log(`\ncapture #${seq} — ${aps.length} APs in ${batches} batch(es) -> ${BASE}`);

  for (let b = 0; b < batches; b++) {
    const slice = aps.slice(b * BATCH, (b + 1) * BATCH);
    const body = {
      device: {
        id: DEVICE_ID,
        name: 'scout-8F68 (simulated)',
        fw: '1.0.0',
        ip: '192.168.1.42',
        uplink_ssid: 'iPhone Hotspot',
        uplink_rssi: rint(-70, -40),
        uptime_s: seq * 120,
        free_heap: rint(180000, 230000),
      },
      capture: {
        seq,
        epoch: Math.floor(Date.now() / 1000),
        duration_ms: rint(7000, 9000),
        frames: rint(300, 900),
        frames_dropped: 0,
        scan_records: aps.length,
        ap_total: aps.length,
        table_overflow: 0,
        batch: b,
        batches,
      },
      aps: slice,
    };

    const headers = { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID };
    if (TOKEN) headers['X-Scout-Token'] = TOKEN;

    try {
      const res = await fetch(`${BASE}/api/ingest`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`  batch ${b + 1}/${batches}: ${res.status} ${text.slice(0, 160)}`);
      if (!res.ok) process.exitCode = 1;
    } catch (err) {
      console.error(`  batch ${b + 1}/${batches}: request failed — ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
}

await sendCapture();
if (LOOP > 0) {
  console.log(`\nLooping every ${LOOP}s — Ctrl-C to stop.`);
  setInterval(sendCapture, LOOP * 1000);
}
