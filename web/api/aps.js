// GET /api/aps — every access point recorded so far.

import { listAps } from '../lib/db.js';
import { cors, json, guard } from '../lib/http.js';

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  return json(res, 200, await listAps());
});
