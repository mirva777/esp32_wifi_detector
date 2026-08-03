// POST /api/purge — wipe every stored reading. Requires the device token.

import { purge } from '../lib/db.js';
import { cors, json, checkToken, guard } from '../lib/http.js';

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const auth = checkToken(req);
  if (!auth.ok) return json(res, auth.code, { error: auth.reason });

  await purge();
  console.log('[admin] database cleared');
  return json(res, 200, { ok: true });
});
