#!/usr/bin/env node
// server.mjs — ingest endpoint + live dashboard for WiFi Scout.
// Runs on Node's standard library alone: no npm install required.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

import { initOui } from '../web/lib/oui.mjs';
import { initDb, ingest, listAps, listDevices, apHistory, stats, purge } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC    = join(__dirname, '..', 'web', 'public');
const DATA      = join(__dirname, 'data');
const PORT      = Number(process.env.PORT || 8080);
const MAX_BODY  = 2 * 1024 * 1024;

const ouiSource = initOui(DATA);
initDb(DATA);

// ---------------------------------------------------------------------------
// Server-sent events: push a nudge to every open dashboard on new data.
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel  = urlPath === '/' ? '/index.html' : urlPath;
  // normalize() collapses "..", so the prefix check below cannot be escaped.
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // The dashboard and the device may sit on different hotspot addresses.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
    // --- device ingest ----------------------------------------------------
    if (path === '/api/ingest' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        console.warn(`[ingest] bad JSON from ${req.socket.remoteAddress}: ${err.message}`);
        return sendJson(res, 400, { error: 'invalid JSON' });
      }

      const result = ingest(payload);
      const dev = payload.device || {};
      const cap = payload.capture || {};
      console.log(
        `[ingest] ${dev.name || dev.id || '?'} seq=${cap.seq} ` +
        `batch ${(cap.batch ?? 0) + 1}/${cap.batches ?? 1} — ` +
        `${result.stored} APs stored` +
        (result.rejected ? `, ${result.rejected} REJECTED (bad BSSID)` : '') +
        ` (${cap.ap_total ?? '?'} total, ${cap.frames ?? 0} frames, ` +
        `${cap.duration_ms ?? 0} ms)`
      );

      broadcast('update', { seq: cap.seq, device: dev.id, aps: result.stored });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // --- dashboard data ---------------------------------------------------
    if (path === '/api/aps')     return sendJson(res, 200, listAps());
    if (path === '/api/devices') return sendJson(res, 200, listDevices());
    if (path === '/api/stats')   return sendJson(res, 200, { ...stats(), oui: ouiSource });

    if (path === '/api/history') {
      const bssid = url.searchParams.get('bssid') || '';
      if (!/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(bssid)) {
        return sendJson(res, 400, { error: 'bssid required' });
      }
      return sendJson(res, 200, apHistory(bssid));
    }

    if (path === '/api/purge' && req.method === 'POST') {
      purge();
      broadcast('update', { purged: true });
      console.log('[admin] database cleared');
      return sendJson(res, 200, { ok: true });
    }

    // --- live event stream ------------------------------------------------
    if (path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET') return await serveStatic(res, path);
    res.writeHead(405).end('method not allowed');
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('');
  console.log('  WiFi Scout dashboard');
  console.log('  ────────────────────────────────────────────');
  console.log(`  Local      http://localhost:${PORT}`);
  for (const a of addrs) {
    console.log(`  Network    http://${a.address}:${PORT}   (${a.name})`);
  }
  console.log('');
  console.log(`  Vendor DB  ${ouiSource}`);
  console.log(`  Database   ${join(DATA, 'scout.db')}`);
  console.log('');
  if (addrs.length) {
    console.log('  Put one of the Network URLs into the ESP32 config portal.');
    console.log('  Use the address on the same network as the ESP32 hotspot.');
  } else {
    console.log('  No external network interface found — connect to your hotspot.');
  }
  console.log('');
});
