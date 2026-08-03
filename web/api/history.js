// GET /api/history?bssid=… — RSSI samples over time for one access point.

import { apHistory } from '../lib/db.js';
import { cors, json, guard } from '../lib/http.js';

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  const bssid = String(req.query?.bssid || '');
  if (!MAC_RE.test(bssid)) return json(res, 400, { error: 'valid bssid required' });
  return json(res, 200, await apHistory(bssid));
});
