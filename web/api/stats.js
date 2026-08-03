// GET /api/stats — aggregate counts for the dashboard header and charts.

import { stats } from '../lib/db.js';
import { ouiSource } from '../lib/oui.mjs';
import { cors, json, guard } from '../lib/http.js';

export default guard(async (req, res) => {
  if (cors(req, res)) return;
  return json(res, 200, { ...(await stats()), oui: ouiSource() });
});
