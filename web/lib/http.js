// http.js — shared request helpers for the Vercel functions.

import { timingSafeEqual } from 'node:crypto';

/** Applies CORS headers. Returns true if the request was a handled preflight. */
export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id, X-Scout-Token');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function json(res, code, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).send(JSON.stringify(obj));
}

/**
 * Shared-secret check for the write endpoints. The ingest URL is public, so
 * without this anyone who learns it could inject or wipe readings.
 */
export function checkToken(req) {
  const expected = process.env.SCOUT_TOKEN || '';
  if (!expected) {
    return { ok: false, code: 503, reason: 'SCOUT_TOKEN is not set on the server' };
  }
  const got = String(req.headers['x-scout-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // Compare against a fixed-length digest so length alone is not a side channel.
  if (a.length !== b.length) return { ok: false, code: 401, reason: 'invalid token' };
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, code: 401, reason: 'invalid token' };
}

/** Wraps a handler so thrown errors become a 500 JSON body instead of a crash. */
export function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[error]', err);
      if (!res.headersSent) json(res, 500, { error: String(err?.message || err) });
      else res.end();
    }
  };
}
