/* app.js — WiFi Scout dashboard.
 *
 * Talks to the same JSON API whether it is served by the local Node server or
 * by Vercel functions. Live updates come from SSE where available (local
 * server) and fall back to polling (serverless).
 */

const $ = (sel) => document.querySelector(sel);

let aps = [];
let sortKey = 'rssi';
let sortAsc = false;
let selected = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function signalBars(rssi) {
  // Four bars, mapped to the usual -50 / -60 / -70 dBm break points.
  const level = rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : rssi >= -80 ? 1 : 0;
  const cls = level >= 3 ? '' : level === 2 ? 'w2' : 'w1';
  const bars = [5, 8, 11, 15]
    .map((h, i) => `<i class="${i < level ? 'on' : ''}" style="height:${h}px"></i>`)
    .join('');
  return `<span class="sig"><span class="dbm">${rssi} dBm</span>
          <span class="sigbars ${cls}">${bars}</span></span>`;
}

function securityTag(ap) {
  const s = ap.security || {};
  if (s.wpa3 || s.sae)  return '<span class="tag wpa3">WPA3</span>';
  if (s.wpa2)           return '<span class="tag wpa2">WPA2</span>';
  if (s.wpa1)           return '<span class="tag wpa1">WPA</span>';
  if (s.wep)            return '<span class="tag wep">WEP</span>';
  return '<span class="tag open">OPEN</span>';
}

function securityRank(ap) {
  const s = ap.security || {};
  if (s.wpa3 || s.sae) return 4;
  if (s.wpa2) return 3;
  if (s.wpa1) return 2;
  if (s.wep)  return 1;
  return 0;
}

function modelCell(ap) {
  const w = ap.wps || {};
  const mk = (w.manufacturer || '').trim();
  const md = (w.model_name || '').trim();
  const nu = (w.model_number || '').trim();
  if (!mk && !md) return '<span class="dash">—</span>';
  const line = md ? `${esc(md)}${nu ? ' ' + esc(nu) : ''}` : '';
  return `<span class="model">${mk ? `<span class="mk">${esc(mk)}</span> ` : ''}${line}</span>`;
}

function duration(sec) {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const relTime = (ms) => {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderCards(st) {
  const cards = [
    { v: st.total_aps,   k: 'Access points',   c: 'accent' },
    { v: st.identified,  k: 'Model identified', c: 'green' },
    { v: st.open_nets,   k: 'Open networks',   c: st.open_nets ? 'red' : '' },
    { v: st.hidden_nets, k: 'Hidden SSIDs',    c: 'amber' },
    { v: (st.channels || []).length, k: 'Channels in use', c: '' },
    { v: st.total_obs,   k: 'Observations',    c: '' },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card ${c.c}">
      <div class="v">${c.v ?? 0}</div>
      <div class="k">${c.k}</div>
    </div>`).join('');
}

function renderChannels(st) {
  const counts = new Map((st.channels || []).map((r) => [Number(r.channel), Number(r.c)]));
  const max = Math.max(1, ...counts.values());
  let html = '';
  for (let ch = 1; ch <= 13; ch++) {
    const n = counts.get(ch) || 0;
    const h = n ? Math.round((n / max) * 78) + 6 : 3;
    // 1, 6 and 11 are the non-overlapping channels; anything crowded elsewhere
    // is worth flagging.
    const cls = n === 0 ? 'free' : (n > max * 0.6 ? 'busy' : '');
    html += `<div class="chan ${cls}" title="Channel ${ch}: ${n} AP(s)">
               <span class="c">${n || ''}</span>
               <span class="bar" style="height:${h}px"></span>
               <span class="n">${ch}</span>
             </div>`;
  }
  $('#channels').innerHTML = html;
}

function renderDevices(devs) {
  $('#devices').innerHTML = devs.map((d) => {
    const stale = Date.now() - Number(d.last_seen) > 10 * 60 * 1000;
    return `<div class="device ${stale ? 'stale' : ''}" title="${esc(d.id)}">
      <b>${esc(d.name || d.id)}</b>
      <span class="muted">${esc(d.uplink_ssid || '')} ${d.uplink_rssi ? d.uplink_rssi + ' dBm' : ''}
      &middot; ${d.captures} scans &middot; ${relTime(Number(d.last_seen))}</span>
    </div>`;
  }).join('');
}

function sortValue(ap, key) {
  switch (key) {
    case 'rssi':       return ap.rssi ?? -100;
    case 'ssid':       return (ap.ssid || '￿').toLowerCase();
    case 'vendor':     return (ap.vendor || '￿').toLowerCase();
    case 'model':      return ((ap.wps?.manufacturer || '') + (ap.wps?.model_name || '') || '￿').toLowerCase();
    case 'channel':    return ap.channel ?? 0;
    case 'generation': return ap.phy?.max_mbps ?? 0;
    case 'security':   return securityRank(ap);
    case 'stations':   return ap.load?.present ? (ap.load.stations ?? 0) : -1;
    case 'uptime':     return ap.beacon?.uptime_s ?? 0;
    case 'lastseen':   return Number(ap.last_seen) || 0;
    default:           return 0;
  }
}

// An AP is "in range" if it appeared in the most recent scans. Anchoring to the
// newest observation rather than wall-clock means the whole table does not grey
// out just because the scout is unplugged — and it adapts to whatever scan
// interval the device is configured with.
const STALE_AFTER_MS = 3 * 60 * 1000;

function latestObservation() {
  return aps.reduce((max, ap) => Math.max(max, Number(ap.last_seen) || 0), 0);
}

function isGone(ap, latest) {
  return latest - (Number(ap.last_seen) || 0) > STALE_AFTER_MS;
}

function visibleRows() {
  const q = $('#search').value.trim().toLowerCase();
  const sec = $('#secfilter').value;
  const presence = $('#presence').value;
  const latest = latestObservation();

  let rows = aps.filter((ap) => {
    if (presence === 'live' && isGone(ap, latest)) return false;
    if (presence === 'gone' && !isGone(ap, latest)) return false;
    if (q) {
      const hay = [
        ap.ssid, ap.bssid, ap.vendor,
        ap.wps?.manufacturer, ap.wps?.model_name, ap.wps?.model_number,
        ap.wps?.device_name, ap.auth, ap.phy?.generation,
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (sec) {
      const s = ap.security || {};
      if (sec === 'open' && (s.wpa1 || s.wpa2 || s.wpa3 || s.wep)) return false;
      if (sec === 'wep'  && !s.wep)  return false;
      if (sec === 'wpa1' && !s.wpa1) return false;
      if (sec === 'wpa2' && !s.wpa2) return false;
      if (sec === 'wpa3' && !s.wpa3) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    const x = sortValue(a, sortKey), y = sortValue(b, sortKey);
    if (x < y) return sortAsc ? -1 : 1;
    if (x > y) return sortAsc ? 1 : -1;
    return 0;
  });
  return rows;
}

function renderTable() {
  const rows = visibleRows();
  $('#apcount').textContent = `${rows.length} of ${aps.length}`;
  $('#empty').style.display = aps.length ? 'none' : 'block';

  const latest = latestObservation();

  $('#tbody').innerHTML = rows.map((ap) => {
    const width = ap.bandwidth && ap.bandwidth > 20
      ? `<div class="sub">${ap.bandwidth} MHz</div>` : '';
    const stations = ap.load?.present ? ap.load.stations : null;
    const gone = isGone(ap, latest);
    return `<tr data-bssid="${esc(ap.bssid)}" class="${gone ? 'gone' : ''}">
      <td class="num">${signalBars(ap.rssi ?? -100)}</td>
      <td>
        <div class="ssid ${ap.hidden ? 'hidden-net' : ''}">${ap.hidden ? '&lt;hidden&gt;' : esc(ap.ssid) || '&lt;unnamed&gt;'}</div>
        <div class="sub">${esc(ap.bssid)}</div>
      </td>
      <td>${esc(ap.vendor) || '<span class="dash">—</span>'}
          ${ap.virtual_bssid ? '<div class="sub">virtual BSSID</div>' : ''}</td>
      <td>${modelCell(ap)}</td>
      <td class="num">${ap.channel || '—'}${width}</td>

      <td><span class="tag gen">${esc(ap.phy?.generation || '—')}</span></td>
      <td>${securityTag(ap)}${ap.wps?.active ? ' <span class="tag wps">WPS</span>' : ''}</td>
      <td class="num">${stations === null || stations < 0 ? '<span class="dash">—</span>' : stations}</td>
      <td class="num">${duration(ap.beacon?.uptime_s)}</td>
      <td class="num">${relTime(Number(ap.last_seen))}
          ${gone ? '<div class="sub">out of range</div>' : ''}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.bssid));
  });

  // A malformed row template (a dropped ">" swallows the first cell as an
  // attribute) shifts every column under the wrong heading, which is easy to
  // miss by eye. Fail loudly instead.
  const firstRow = $('#tbody').firstElementChild;
  if (firstRow) {
    const head = document.querySelectorAll('#aptable thead th').length;
    const body = firstRow.children.length;
    if (head !== body) {
      console.error(`Table column mismatch: ${head} headers vs ${body} cells — row markup is malformed.`);
    }
  }

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.classList.toggle('asc', th.dataset.sort === sortKey && sortAsc);
  });
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------
function kv(pairs) {
  const body = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd class="${mono ? 'mono' : ''}">${v}</dd>`)
    .join('');
  return body ? `<dl class="kv">${body}</dl>` : '<p class="muted">Not advertised.</p>';
}

function flagList(obj, labels) {
  const on = Object.entries(labels).filter(([k]) => obj?.[k]);
  if (!on.length) return '<p class="muted">None advertised.</p>';
  return `<div class="flags">${on.map(([, l]) => `<span class="tag gen">${esc(l)}</span>`).join('')}</div>`;
}

function sparkline(points) {
  if (!points || points.length < 2) return '<p class="muted">Not enough history yet.</p>';
  const vals = points.map((p) => Number(p.rssi));
  // Plot against a fixed -95..-30 dBm scale so shapes are comparable between
  // APs, but label the axis with the values actually observed.
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const axisMin = Math.min(lo, -95), axisMax = Math.max(hi, -30);
  const range = Math.max(1, axisMax - axisMin);
  const W = 500, H = 60;
  const d = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - axisMin) / range) * (H - 8) - 4;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const span = new Date(Number(points[0].ts)).toLocaleString();
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="#2f81f7" stroke-width="2"
          vector-effect="non-scaling-stroke"/>
  </svg>
  <p class="muted" style="font-size:12px;margin:2px 0 0">
    ${points.length} samples &middot; ${lo} to ${hi} dBm &middot; since ${esc(span)}</p>`;
}

async function openDrawer(bssid) {
  const ap = aps.find((a) => a.bssid === bssid);
  if (!ap) return;
  selected = bssid;

  $('#d-ssid').innerHTML = ap.hidden ? '&lt;hidden network&gt;' : (esc(ap.ssid) || '&lt;unnamed&gt;');
  $('#d-bssid').textContent = ap.bssid;

  const w = ap.wps || {}, s = ap.security || {}, p = ap.phy || {};
  const b = ap.beacon || {}, l = ap.load || {}, c = ap.country || {};

  const secondary = ap.sec_chan === 1 ? 'above' : ap.sec_chan === -1 ? 'below' : null;

  $('#d-body').innerHTML = `
    <div class="grp"><h3>Identity</h3>${kv([
      ['Vendor (OUI)', esc(ap.vendor) || '<span class="muted">unknown</span>'],
      ['Manufacturer', esc(w.manufacturer)],
      ['Model', esc(w.model_name)],
      ['Model number', esc(w.model_number)],
      ['Device name', esc(w.device_name)],
      ['Serial', esc(w.serial), true],
      ['Device type', esc(w.category)],
      ['WPS UUID', esc(w.uuid), true],
      ['Reported by', esc(ap.device_id), true],
    ])}</div>

    <div class="grp"><h3>Radio</h3>${kv([
      ['Signal (best / last)', `${ap.best_rssi ?? ap.rssi} dBm / ${ap.rssi} dBm`],
      ['Channel', ap.channel],
      ['Secondary channel', secondary],
      ['Bandwidth', ap.bandwidth ? `${ap.bandwidth} MHz` : null],
      ['Generation', esc(p.generation)],
      ['Spatial streams', p.streams || null],
      ['Peak PHY rate', p.max_mbps ? `${p.max_mbps} Mbps` : null],
      ['Beacon interval', b.interval_tu ? `${b.interval_tu} TU (${Math.round(b.interval_tu * 1.024)} ms)` : null],
      ['DTIM period', b.dtim || null],
    ])}</div>

    <div class="grp"><h3>PHY modes</h3>${flagList(p, {
      b: '802.11b', g: '802.11g', n: '802.11n', ac: '802.11ac',
      ax: '802.11ax', be: '802.11be', lr: 'Espressif long range',
    })}</div>

    <div class="grp"><h3>Security</h3>${kv([
      ['Auth mode', esc(ap.auth)],
      ['Pairwise cipher', esc(s.pairwise)],
      ['Group cipher', esc(s.group)],
      ['Protected management frames', s.pmf_required ? 'required' : s.pmf_capable ? 'capable' : 'no'],
      ['WPS', w.active ? (w.state === 1 ? 'enabled (unconfigured)' : 'enabled') : null],
    ])}
    <div style="margin-top:8px">${flagList(s, {
      wep: 'WEP', wpa1: 'WPA', wpa2: 'WPA2', wpa3: 'WPA3', owe: 'OWE',
      psk: 'PSK', sae: 'SAE', dot1x: '802.1X', ft: 'Fast transition', suiteb: 'Suite-B',
    })}</div></div>

    <div class="grp"><h3>Load &amp; uptime</h3>${kv([
      ['Associated clients', l.present ? l.stations : '<span class="muted">not advertised</span>'],
      ['Channel utilisation', l.present ? `${l.utilization_pct}%` : null],
      ['Time since AP reboot', duration(b.uptime_s)],
      ['First seen', ap.first_seen ? new Date(Number(ap.first_seen)).toLocaleString() : null],
      ['Last seen', ap.last_seen ? new Date(Number(ap.last_seen)).toLocaleString() : null],
      ['Times observed', ap.times_seen],
    ])}</div>

    <div class="grp"><h3>Roaming &amp; measurement</h3>${flagList(ap.features, {
      rrm_11k: '802.11k radio measurement',
      btm_11v: '802.11v BSS transition',
      ft_11r: '802.11r fast roaming',
      ftm_responder: '802.11mc FTM responder',
      ftm_initiator: 'FTM initiator',
    })}</div>

    <div class="grp"><h3>Regulatory</h3>${kv([
      ['Country', esc(c.code)],
      ['Max TX power', c.max_tx_dbm ? `${c.max_tx_dbm} dBm` : null],
      ['Allowed channels', c.num_chans ? `${c.first_chan}–${c.first_chan + c.num_chans - 1}` : null],
    ])}</div>

    <div class="grp"><h3>Vendor elements</h3>${
      (ap.vendor_ies || []).length
        ? `<div class="flags">${ap.vendor_ies.map((o) =>
            `<span class="tag gen mono">${esc(o.replace(/(..)(..)(..)/, '$1:$2:$3'))}</span>`).join('')}</div>`
        : '<p class="muted">None beyond the standard ones.</p>'
    }</div>

    <div class="grp"><h3>Capture stats</h3>${kv([
      ['Beacons heard', ap.stats?.beacons],
      ['Probe responses', ap.stats?.probe_resps],
      ['Seen by driver scan', ap.stats?.in_scan ? 'yes' : 'no'],
    ])}</div>

    <div class="grp"><h3>Signal history</h3><div id="d-spark">Loading…</div></div>
  `;

  $('#drawer').hidden = false;
  $('#scrim').hidden = false;

  try {
    const hist = await fetch(`/api/history?bssid=${encodeURIComponent(bssid)}`).then((r) => r.json());
    if (selected === bssid) $('#d-spark').innerHTML = sparkline(hist);
  } catch {
    if (selected === bssid) $('#d-spark').innerHTML = '<p class="muted">History unavailable.</p>';
  }
}

function closeDrawer() {
  selected = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function refresh() {
  try {
    const [apList, st, devs] = await Promise.all([
      fetch('/api/aps').then((r) => r.json()),
      fetch('/api/stats').then((r) => r.json()),
      fetch('/api/devices').then((r) => r.json()),
    ]);
    aps = Array.isArray(apList) ? apList : [];
    renderCards(st);
    renderChannels(st);
    renderDevices(Array.isArray(devs) ? devs : []);
    renderTable();
    setLive(true, `${aps.length} APs · updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setLive(false, 'connection lost');
  }
}

function setLive(ok, text) {
  $('#dot').className = `dot ${ok ? 'on' : 'off'}`;
  $('#livetext').textContent = text;
}

// SSE where the backend supports it (local server); polling covers serverless.
function connectLive() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('update', refresh);
    es.onerror = () => { es.close(); setTimeout(connectLive, 15000); };
  } catch { /* polling still runs */ }
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------
$('#search').addEventListener('input', renderTable);
$('#secfilter').addEventListener('change', renderTable);
$('#presence').addEventListener('change', renderTable);
$('#closedrawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (k === sortKey) sortAsc = !sortAsc;
    else { sortKey = k; sortAsc = k === 'ssid' || k === 'vendor' || k === 'model'; }
    renderTable();
  });
});

// The deployed endpoint requires the same shared secret the ESP32 uses; the
// local test server does not. Ask only when the server actually rejects us.
$('#purge').addEventListener('click', async () => {
  if (!confirm('Delete every stored access point and observation?')) return;

  const send = (token) => fetch('/api/purge', {
    method: 'POST',
    headers: token ? { 'X-Scout-Token': token } : {},
  });

  let res = await send(localStorage.getItem('scoutToken') || '');
  if (res.status === 401 || res.status === 503) {
    const token = prompt('Upload token (SCOUT_TOKEN) required to clear data:');
    if (!token) return;
    res = await send(token);
    if (res.ok) localStorage.setItem('scoutToken', token);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Could not clear data: ${body.error || res.status}`);
    return;
  }
  refresh();
});

refresh();
connectLive();
setInterval(refresh, 15000);
