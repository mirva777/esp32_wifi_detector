// POST /api/ingest — receives one batch of scan results from an ESP32.

import { ingest } from '../lib/db.js';
import { cors, json, checkToken, guard } from '../lib/http.js';

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const auth = checkToken(req);
  if (!auth.ok) return json(res, auth.code, { error: auth.reason });

  // Vercel parses application/json into req.body; fall back for odd content types.
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    return json(res, 400, { error: 'invalid JSON body' });
  }

  const result = await ingest(payload);
  const dev = payload.device || {};
  const cap = payload.capture || {};
  console.log(
    `[ingest] ${dev.name || dev.id || '?'} seq=${cap.seq} ` +
    `batch ${(cap.batch ?? 0) + 1}/${cap.batches ?? 1} — ` +
    `${result.stored} APs (${cap.ap_total ?? '?'} total, ${cap.frames ?? 0} frames)`
  );

  return json(res, 200, { ok: true, ...result });
});
