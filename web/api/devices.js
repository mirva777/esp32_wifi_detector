// GET /api/devices — the ESP32 scouts that have reported in.

import { listDevices } from '../lib/db.js';
import { cors, json, guard } from '../lib/http.js';

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  return json(res, 200, await listDevices());
});
