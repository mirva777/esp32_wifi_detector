// db.js — Postgres persistence for the Vercel deployment.
//
// Uses the Neon serverless driver, which speaks HTTP rather than holding a TCP
// pool open. That matters here: serverless functions are short-lived and a
// classic pool would exhaust connection limits under bursty ingest.

import { neon } from '@neondatabase/serverless';
import { lookupVendor } from './oui.mjs';

let _sql = null;

function sql() {
  if (_sql) return _sql;
  const conn =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL_UNPOOLED;
  if (!conn) {
    throw new Error(
      'No Postgres connection string. Add a Neon/Postgres integration in the ' +
      'Vercel dashboard, or set DATABASE_URL.'
    );
  }
  _sql = neon(conn);
  return _sql;
}

// ---------------------------------------------------------------------------
// Schema — created on demand, cached per warm instance.
// ---------------------------------------------------------------------------
let schemaPromise = null;

export function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const s = sql();
    await s.query(`
      CREATE TABLE IF NOT EXISTS aps (
        bssid       TEXT PRIMARY KEY,
        ssid        TEXT    DEFAULT '',
        ssid_hex    TEXT    DEFAULT '',
        hidden      BOOLEAN DEFAULT FALSE,
        vendor      TEXT    DEFAULT '',
        first_seen  BIGINT,
        last_seen   BIGINT,
        times_seen  INTEGER DEFAULT 0,
        best_rssi   INTEGER,
        last_rssi   INTEGER,
        channel     INTEGER,
        sec_chan    INTEGER,
        bandwidth   INTEGER,
        auth        TEXT    DEFAULT '',
        generation  TEXT    DEFAULT '',
        max_mbps    INTEGER,
        stations    INTEGER,
        ap_uptime_s BIGINT,
        wps_vendor  TEXT    DEFAULT '',
        wps_model   TEXT    DEFAULT '',
        device_id   TEXT    DEFAULT '',
        detail      JSONB
      )`);
    await s.query(`
      CREATE TABLE IF NOT EXISTS observations (
        id        BIGSERIAL PRIMARY KEY,
        ts        BIGINT,
        bssid     TEXT,
        device_id TEXT,
        seq       INTEGER,
        rssi      INTEGER,
        channel   INTEGER,
        stations  INTEGER
      )`);
    await s.query('CREATE INDEX IF NOT EXISTS idx_obs_bssid ON observations (bssid, ts DESC)');
    await s.query('CREATE INDEX IF NOT EXISTS idx_obs_ts    ON observations (ts DESC)');
    await s.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id           TEXT PRIMARY KEY,
        name         TEXT    DEFAULT '',
        fw           TEXT    DEFAULT '',
        ip           TEXT    DEFAULT '',
        uplink_ssid  TEXT    DEFAULT '',
        uplink_rssi  INTEGER,
        uptime_s     BIGINT,
        free_heap    BIGINT,
        last_seen    BIGINT,
        last_seq     INTEGER,
        captures     INTEGER DEFAULT 0,
        last_capture JSONB
      )`);
  })().catch((err) => {
    schemaPromise = null;              // let the next request retry
    throw err;
  });
  return schemaPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Recover the SSID from the raw hex the firmware sends. Beacons carry arbitrary
 * bytes, so this restores names the device's ASCII rendering cannot represent
 * (Cyrillic, CJK, emoji), and falls back cleanly on invalid UTF-8.
 */
function decodeSsid(hex, asciiFallback) {
  if (!hex) return asciiFallback || '';
  try {
    const bytes = Buffer.from(hex, 'hex');
    if (!bytes.length) return asciiFallback || '';
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.replace(/[\u0000-\u001F\u007F]/g, '');  // strip control bytes
  } catch {
    return asciiFallback || '';
  }
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** Build "($1,$2,...),($n,...)" placeholder groups for a multi-row insert. */
function placeholders(rows, cols) {
  let n = 0;
  return rows
    .map(() => `(${Array.from({ length: cols }, () => `$${++n}`).join(',')})`)
    .join(',');
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
export async function ingest(payload) {
  await ensureSchema();
  const s = sql();

  const now = Date.now();
  const dev = payload.device || {};
  const cap = payload.capture || {};
  const rawAps = Array.isArray(payload.aps) ? payload.aps : [];

  // Prefer the device's NTP-synced clock when it has one.
  const ts = Number(cap.epoch) > 1600000000 ? Number(cap.epoch) * 1000 : now;

  // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so
  // collapse any duplicate BSSIDs within the batch first.
  const byBssid = new Map();
  for (const ap of rawAps) {
    const bssid = String(ap.bssid || '').toLowerCase();
    if (MAC_RE.test(bssid)) byBssid.set(bssid, ap);
  }
  const aps = [...byBssid.entries()];

  if (aps.length) {
    const apCols = 22;
    const apVals = [];
    for (const [bssid, ap] of aps) {
      const ssid   = decodeSsid(ap.ssid_hex, ap.ssid);
      const vendor = lookupVendor(bssid);
      const wps    = ap.wps || {};
      const phy    = ap.phy || {};
      const load   = ap.load || {};
      const beacon = ap.beacon || {};
      apVals.push(
        bssid, ssid, ap.ssid_hex || '', !!ap.hidden, vendor,
        ts, ts, 1,
        ap.rssi ?? -100, ap.rssi_last ?? ap.rssi ?? -100,
        ap.channel ?? 0, ap.sec_chan ?? 0, ap.bandwidth ?? 20,
        ap.auth || '', phy.generation || '', phy.max_mbps ?? 0,
        load.present ? (load.stations ?? 0) : -1,
        beacon.uptime_s ?? 0,
        wps.manufacturer || '', wps.model_name || '',
        dev.id || '',
        JSON.stringify({ ...ap, ssid, vendor })
      );
    }

    await s.query(`
      INSERT INTO aps (bssid, ssid, ssid_hex, hidden, vendor, first_seen, last_seen,
                       times_seen, best_rssi, last_rssi, channel, sec_chan, bandwidth,
                       auth, generation, max_mbps, stations, ap_uptime_s,
                       wps_vendor, wps_model, device_id, detail)
      VALUES ${placeholders(aps, apCols)}
      ON CONFLICT (bssid) DO UPDATE SET
        ssid        = CASE WHEN EXCLUDED.ssid       <> '' THEN EXCLUDED.ssid       ELSE aps.ssid       END,
        ssid_hex    = CASE WHEN EXCLUDED.ssid_hex   <> '' THEN EXCLUDED.ssid_hex   ELSE aps.ssid_hex   END,
        hidden      = EXCLUDED.hidden,
        vendor      = EXCLUDED.vendor,
        last_seen   = EXCLUDED.last_seen,
        times_seen  = aps.times_seen + 1,
        best_rssi   = GREATEST(aps.best_rssi, EXCLUDED.best_rssi),
        last_rssi   = EXCLUDED.last_rssi,
        channel     = EXCLUDED.channel,
        sec_chan    = EXCLUDED.sec_chan,
        bandwidth   = EXCLUDED.bandwidth,
        auth        = EXCLUDED.auth,
        generation  = EXCLUDED.generation,
        max_mbps    = EXCLUDED.max_mbps,
        stations    = EXCLUDED.stations,
        ap_uptime_s = EXCLUDED.ap_uptime_s,
        wps_vendor  = CASE WHEN EXCLUDED.wps_vendor <> '' THEN EXCLUDED.wps_vendor ELSE aps.wps_vendor END,
        wps_model   = CASE WHEN EXCLUDED.wps_model  <> '' THEN EXCLUDED.wps_model  ELSE aps.wps_model  END,
        device_id   = EXCLUDED.device_id,
        detail      = EXCLUDED.detail
    `, apVals);

    const obsVals = [];
    for (const [bssid, ap] of aps) {
      const load = ap.load || {};
      obsVals.push(
        ts, bssid, dev.id || '', cap.seq ?? 0,
        ap.rssi ?? -100, ap.channel ?? 0,
        load.present ? (load.stations ?? 0) : -1
      );
    }
    await s.query(
      `INSERT INTO observations (ts, bssid, device_id, seq, rssi, channel, stations)
       VALUES ${placeholders(aps, 7)}`,
      obsVals
    );
  }

  // Count one capture per distinct sequence number, not per batch.
  const prev = await s.query('SELECT captures, last_seq FROM devices WHERE id = $1',
                             [dev.id || 'unknown']);
  const existing = prev[0];
  const isNewCapture = !existing || Number(existing.last_seq) !== (cap.seq ?? 0);
  const captures = (Number(existing?.captures) || 0) + (isNewCapture ? 1 : 0);

  await s.query(`
    INSERT INTO devices (id, name, fw, ip, uplink_ssid, uplink_rssi, uptime_s,
                         free_heap, last_seen, last_seq, captures, last_capture)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, fw = EXCLUDED.fw, ip = EXCLUDED.ip,
      uplink_ssid = EXCLUDED.uplink_ssid, uplink_rssi = EXCLUDED.uplink_rssi,
      uptime_s = EXCLUDED.uptime_s, free_heap = EXCLUDED.free_heap,
      last_seen = EXCLUDED.last_seen, last_seq = EXCLUDED.last_seq,
      captures = EXCLUDED.captures, last_capture = EXCLUDED.last_capture
  `, [
    dev.id || 'unknown', dev.name || '', dev.fw || '', dev.ip || '',
    dev.uplink_ssid || '', dev.uplink_rssi ?? 0, dev.uptime_s ?? 0,
    dev.free_heap ?? 0, now, cap.seq ?? 0, captures, JSON.stringify(cap),
  ]);

  return { stored: aps.length, batch: cap.batch ?? 0, batches: cap.batches ?? 1 };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export async function listAps() {
  await ensureSchema();
  const rows = await sql().query('SELECT * FROM aps ORDER BY last_rssi DESC LIMIT 2000');
  return rows.map((r) => ({
    ...(r.detail || {}),
    bssid: r.bssid,
    ssid: r.ssid,
    vendor: r.vendor,
    hidden: !!r.hidden,
    first_seen: Number(r.first_seen),
    last_seen: Number(r.last_seen),
    times_seen: Number(r.times_seen),
    best_rssi: r.best_rssi,
    rssi: r.last_rssi,
    device_id: r.device_id,
  }));
}

export async function listDevices() {
  await ensureSchema();
  return sql().query('SELECT * FROM devices ORDER BY last_seen DESC');
}

export async function apHistory(bssid, limit = 500) {
  await ensureSchema();
  const rows = await sql().query(
    `SELECT ts, rssi, channel, stations FROM observations
     WHERE bssid = $1 ORDER BY ts DESC LIMIT $2`,
    [bssid.toLowerCase(), limit]
  );
  return rows.reverse();
}

export async function stats() {
  await ensureSchema();
  const s = sql();
  const [totals, channels, vendors, generations, security] = await Promise.all([
    s.query(`SELECT
       (SELECT COUNT(*) FROM aps)                                          AS total_aps,
       (SELECT COUNT(*) FROM observations)                                 AS total_obs,
       (SELECT COUNT(*) FROM aps WHERE wps_model <> '')                    AS identified,
       (SELECT COUNT(*) FROM aps WHERE auth = 'OPEN')                      AS open_nets,
       (SELECT COUNT(*) FROM aps WHERE hidden)                             AS hidden_nets`),
    s.query('SELECT channel, COUNT(*)::int AS c FROM aps WHERE channel > 0 GROUP BY channel ORDER BY channel'),
    s.query("SELECT vendor, COUNT(*)::int AS c FROM aps WHERE vendor <> '' GROUP BY vendor ORDER BY c DESC LIMIT 15"),
    s.query("SELECT generation, COUNT(*)::int AS c FROM aps WHERE generation <> '' GROUP BY generation ORDER BY c DESC"),
    s.query("SELECT auth, COUNT(*)::int AS c FROM aps WHERE auth <> '' GROUP BY auth ORDER BY c DESC"),
  ]);
  const t = totals[0] || {};
  return {
    total_aps:   Number(t.total_aps   || 0),
    total_obs:   Number(t.total_obs   || 0),
    identified:  Number(t.identified  || 0),
    open_nets:   Number(t.open_nets   || 0),
    hidden_nets: Number(t.hidden_nets || 0),
    channels, vendors, generations, security,
  };
}

export async function purge() {
  await ensureSchema();
  const s = sql();
  await s.query('TRUNCATE aps, observations, devices');
}
