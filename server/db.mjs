// db.mjs — SQLite persistence, using Node's built-in driver (no npm packages).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { lookupVendor, annotateVirtualBssids } from '../web/lib/oui.mjs';

let db;

export function initDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(`${dataDir}/scout.db`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS aps (
      bssid          TEXT PRIMARY KEY,
      ssid           TEXT,
      ssid_hex       TEXT,
      hidden         INTEGER,
      vendor         TEXT,
      first_seen     INTEGER,
      last_seen      INTEGER,
      times_seen     INTEGER DEFAULT 0,
      best_rssi      INTEGER,
      last_rssi      INTEGER,
      channel        INTEGER,
      sec_chan       INTEGER,
      bandwidth      INTEGER,
      auth           TEXT,
      generation     TEXT,
      max_mbps       INTEGER,
      stations       INTEGER,
      ap_uptime_s    INTEGER,
      wps_vendor     TEXT,
      wps_model      TEXT,
      device_id      TEXT,
      detail         TEXT          -- full record as JSON
    );

    CREATE TABLE IF NOT EXISTS observations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER,
      bssid     TEXT,
      device_id TEXT,
      seq       INTEGER,
      rssi      INTEGER,
      channel   INTEGER,
      stations  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_obs_bssid ON observations(bssid, ts);
    CREATE INDEX IF NOT EXISTS idx_obs_ts    ON observations(ts);

    CREATE TABLE IF NOT EXISTS devices (
      id           TEXT PRIMARY KEY,
      name         TEXT,
      fw           TEXT,
      ip           TEXT,
      uplink_ssid  TEXT,
      uplink_rssi  INTEGER,
      uptime_s     INTEGER,
      free_heap    INTEGER,
      last_seen    INTEGER,
      last_seq     INTEGER,
      captures     INTEGER DEFAULT 0,
      last_capture TEXT
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
// Prepared statements are cached on first use — `db` does not exist at module
// load time.
const cache = new Map();
const prep = (key, sql) => {
  if (!cache.has(key)) cache.set(key, db.prepare(sql));
  return cache.get(key);
};

const upsertAp = () => prep('upsertAp', `
  INSERT INTO aps (bssid, ssid, ssid_hex, hidden, vendor, first_seen, last_seen,
                   times_seen, best_rssi, last_rssi, channel, sec_chan, bandwidth,
                   auth, generation, max_mbps, stations, ap_uptime_s,
                   wps_vendor, wps_model, device_id, detail)
  VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(bssid) DO UPDATE SET
    ssid        = CASE WHEN excluded.ssid != '' THEN excluded.ssid ELSE aps.ssid END,
    ssid_hex    = CASE WHEN excluded.ssid_hex != '' THEN excluded.ssid_hex ELSE aps.ssid_hex END,
    hidden      = excluded.hidden,
    vendor      = excluded.vendor,
    last_seen   = excluded.last_seen,
    times_seen  = aps.times_seen + 1,
    best_rssi   = MAX(aps.best_rssi, excluded.best_rssi),
    last_rssi   = excluded.last_rssi,
    channel     = excluded.channel,
    sec_chan    = excluded.sec_chan,
    bandwidth   = excluded.bandwidth,
    auth        = excluded.auth,
    generation  = excluded.generation,
    max_mbps    = excluded.max_mbps,
    stations    = excluded.stations,
    ap_uptime_s = excluded.ap_uptime_s,
    wps_vendor  = CASE WHEN excluded.wps_vendor != '' THEN excluded.wps_vendor ELSE aps.wps_vendor END,
    wps_model   = CASE WHEN excluded.wps_model  != '' THEN excluded.wps_model  ELSE aps.wps_model  END,
    device_id   = excluded.device_id,
    detail      = excluded.detail
`);

const insertObs = () => prep('insertObs', `
  INSERT INTO observations (ts, bssid, device_id, seq, rssi, channel, stations)
  VALUES (?,?,?,?,?,?,?)
`);

/**
 * Decode the SSID from the raw hex the device sends. Beacons carry arbitrary
 * bytes, so this recovers real UTF-8 names (Cyrillic, CJK, emoji) that the
 * firmware's ASCII rendering cannot represent.
 */
function decodeSsid(hex, asciiFallback) {
  if (!hex) return asciiFallback || '';
  try {
    const bytes = Buffer.from(hex, 'hex');
    if (!bytes.length) return asciiFallback || '';
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Strip control bytes; keep everything else, including emoji.
    return text.replace(/[\u0000-\u001F\u007F]/g, '');
  } catch {
    return asciiFallback || '';
  }
}

export function ingest(payload) {
  const now = Date.now();
  const dev = payload.device || {};
  const cap = payload.capture || {};
  const aps = Array.isArray(payload.aps) ? payload.aps : [];

  // Prefer the device's NTP-synced clock; fall back to server time.
  const ts = cap.epoch > 1600000000 ? cap.epoch * 1000 : now;

  const apStmt  = upsertAp();
  const obsStmt = insertObs();

  let stored = 0;
  let rejected = 0;

  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const ap of aps) {
      const bssid = String(ap.bssid || '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid)) { rejected++; continue; }

      const ssid   = decodeSsid(ap.ssid_hex, ap.ssid);
      const wps    = ap.wps || {};
      const phy    = ap.phy || {};
      const load   = ap.load || {};
      const beacon = ap.beacon || {};

      const enriched = { ...ap, ssid, vendor: lookupVendor(bssid) };

      apStmt.run(
        bssid, ssid, ap.ssid_hex || '', ap.hidden ? 1 : 0, lookupVendor(bssid),
        ts, ts,
        ap.rssi ?? -100, ap.rssi_last ?? ap.rssi ?? -100,
        ap.channel ?? 0, ap.sec_chan ?? 0, ap.bandwidth ?? 20,
        ap.auth || '', phy.generation || '', phy.max_mbps ?? 0,
        load.present ? (load.stations ?? 0) : -1,
        beacon.uptime_s ?? 0,
        wps.manufacturer || '', wps.model_name || '',
        dev.id || '', JSON.stringify(enriched)
      );

      obsStmt.run(ts, bssid, dev.id || '', cap.seq ?? 0,
                  ap.rssi ?? -100, ap.channel ?? 0,
                  load.present ? (load.stations ?? 0) : -1);
      stored++;
    }

    // Devices are upserted with plain statements to avoid a custom SQL function.
    const existing = db.prepare('SELECT captures, last_seq FROM devices WHERE id = ?')
                       .get(dev.id || '');
    const isNewCapture = !existing || existing.last_seq !== (cap.seq ?? 0);
    const captures = (existing?.captures ?? 0) + (isNewCapture ? 1 : 0);

    db.prepare(`
      INSERT INTO devices (id, name, fw, ip, uplink_ssid, uplink_rssi, uptime_s,
                           free_heap, last_seen, last_seq, captures, last_capture)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, fw = excluded.fw, ip = excluded.ip,
        uplink_ssid = excluded.uplink_ssid, uplink_rssi = excluded.uplink_rssi,
        uptime_s = excluded.uptime_s, free_heap = excluded.free_heap,
        last_seen = excluded.last_seen, last_seq = excluded.last_seq,
        captures = excluded.captures, last_capture = excluded.last_capture
    `).run(
      dev.id || 'unknown', dev.name || '', dev.fw || '', dev.ip || '',
      dev.uplink_ssid || '', dev.uplink_rssi ?? 0, dev.uptime_s ?? 0,
      dev.free_heap ?? 0, now, cap.seq ?? 0, captures, JSON.stringify(cap)
    );

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }

  // Report what actually landed, not what was offered — a silent mismatch here
  // is exactly the kind of bug that hides behind a 200 OK.
  return { stored, rejected, batch: cap.batch ?? 0, batches: cap.batches ?? 1 };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function listAps() {
  const rows = db.prepare('SELECT * FROM aps ORDER BY last_rssi DESC').all();
  return annotateVirtualBssids(rows.map((r) => ({
    ...JSON.parse(r.detail || '{}'),
    bssid: r.bssid,
    ssid: r.ssid,
    vendor: r.vendor,
    hidden: !!r.hidden,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    times_seen: r.times_seen,
    best_rssi: r.best_rssi,
    rssi: r.last_rssi,
    device_id: r.device_id,
  })));
}

export function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
}

export function apHistory(bssid, limit = 500) {
  return db.prepare(
    'SELECT ts, rssi, channel, stations FROM observations WHERE bssid = ? ORDER BY ts DESC LIMIT ?'
  ).all(bssid.toLowerCase(), limit).reverse();
}

export function stats() {
  const one = (sql) => db.prepare(sql).get();
  return {
    total_aps:    one('SELECT COUNT(*) c FROM aps').c,
    total_obs:    one('SELECT COUNT(*) c FROM observations').c,
    identified:   one("SELECT COUNT(*) c FROM aps WHERE wps_model != '' AND wps_model IS NOT NULL").c,
    open_nets:    one("SELECT COUNT(*) c FROM aps WHERE auth = 'OPEN'").c,
    hidden_nets:  one('SELECT COUNT(*) c FROM aps WHERE hidden = 1').c,
    channels:     db.prepare(
      'SELECT channel, COUNT(*) c FROM aps WHERE channel > 0 GROUP BY channel ORDER BY channel'
    ).all(),
    vendors: db.prepare(
      "SELECT vendor, COUNT(*) c FROM aps WHERE vendor != '' GROUP BY vendor ORDER BY c DESC LIMIT 15"
    ).all(),
    generations: db.prepare(
      "SELECT generation, COUNT(*) c FROM aps WHERE generation != '' GROUP BY generation ORDER BY c DESC"
    ).all(),
    security: db.prepare(
      "SELECT auth, COUNT(*) c FROM aps WHERE auth != '' GROUP BY auth ORDER BY c DESC"
    ).all(),
  };
}

export function purge() {
  db.exec('DELETE FROM aps; DELETE FROM observations; DELETE FROM devices;');
}
