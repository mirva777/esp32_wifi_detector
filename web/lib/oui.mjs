// oui.mjs — map a BSSID to the hardware vendor that registered its MAC block.
//
// The authoritative source is the IEEE MA-L registry. `npm run fetch-oui`
// downloads it to data/oui.csv (~5 MB, ~35k entries). Until that exists we fall
// back to the short table below, which covers the vendors most likely to appear
// in a home or office scan.
//
// Vendor is only a supporting signal: when a router advertises a WPS element it
// reports its own manufacturer and model directly, which is far more precise.

import { readFileSync, existsSync } from 'node:fs';
import { OUI as BUNDLED } from './oui-data.js';

const FALLBACK = {
  // TP-Link
  '000AEB': 'TP-Link', '14CC20': 'TP-Link', '50C7BF': 'TP-Link', '647002': 'TP-Link',
  'A0F3C1': 'TP-Link', 'C04A00': 'TP-Link', 'EC086B': 'TP-Link', '98DAC4': 'TP-Link',
  'B04E26': 'TP-Link', '30B5C2': 'TP-Link', '60E327': 'TP-Link',
  // Ubiquiti
  '00156D': 'Ubiquiti', '0418D6': 'Ubiquiti', '24A43C': 'Ubiquiti', '44D9E7': 'Ubiquiti',
  '687251': 'Ubiquiti', '788A20': 'Ubiquiti', 'DC9FDB': 'Ubiquiti', 'F09FC2': 'Ubiquiti',
  '74ACB9': 'Ubiquiti',
  // MikroTik
  '000C42': 'MikroTik', '4C5E0C': 'MikroTik', '6C3B6B': 'MikroTik', '488F5A': 'MikroTik',
  '2CC81B': 'MikroTik', '744D28': 'MikroTik', 'DC2C6E': 'MikroTik',
  // Netgear
  '00095B': 'Netgear', '00146C': 'Netgear', '204E7F': 'Netgear', '2C3033': 'Netgear',
  'A040A0': 'Netgear', 'C03F0E': 'Netgear', '9C3DCF': 'Netgear', '04A151': 'Netgear',
  // ASUSTek
  '000C6E': 'ASUSTek', '001BFC': 'ASUSTek', '08606E': 'ASUSTek', '2C56DC': 'ASUSTek',
  '38D547': 'ASUSTek', '50465D': 'ASUSTek', 'AC9E17': 'ASUSTek', 'F832E4': 'ASUSTek',
  '04D9F5': 'ASUSTek',
  // D-Link
  '00055D': 'D-Link', '00179A': 'D-Link', '14D64D': 'D-Link', '1C7EE5': 'D-Link',
  '28107B': 'D-Link', '78542E': 'D-Link', 'C8BE19': 'D-Link', '9094E4': 'D-Link',
  // Huawei
  '00E0FC': 'Huawei', '04BD70': 'Huawei', '0819A6': 'Huawei', '286ED4': 'Huawei',
  '487B6B': 'Huawei', '70723C': 'Huawei', '781DBA': 'Huawei', 'E0247F': 'Huawei',
  '88E3AB': 'Huawei',
  // Xiaomi
  '286C07': 'Xiaomi', '34CE00': 'Xiaomi', '50642B': 'Xiaomi', '640980': 'Xiaomi',
  '7811DC': 'Xiaomi', '8CBEBE': 'Xiaomi', 'F0B429': 'Xiaomi', '2082C0': 'Xiaomi',
  // ZTE
  '0015EB': 'ZTE', '08181A': 'ZTE', '344B50': 'ZTE', '4CAC0A': 'ZTE',
  '90C7D8': 'ZTE', 'D0608C': 'ZTE', 'F46DE2': 'ZTE',
  // Zyxel
  '001349': 'Zyxel', '0019CB': 'Zyxel', '5CF4AB': 'Zyxel', 'B0B2DC': 'Zyxel', '404A03': 'Zyxel',
  // Apple
  '000393': 'Apple', '0017F2': 'Apple', '001B63': 'Apple', '3C0754': 'Apple',
  '8863DF': 'Apple', 'F01898': 'Apple', 'A8667F': 'Apple',
  // AVM (FRITZ!Box)
  '00040E': 'AVM', '0896D7': 'AVM', '3431C4': 'AVM', '3810D5': 'AVM',
  'C80E14': 'AVM', '5C4979': 'AVM',
  // Technicolor / Sagemcom / Arris  (common ISP-supplied routers)
  '00147F': 'Technicolor', '001A2A': 'Technicolor', '4432C8': 'Technicolor', '905C44': 'Technicolor',
  '001D19': 'Sagemcom', '444E6D': 'Sagemcom', '68A378': 'Sagemcom', '880355': 'Sagemcom',
  '0015A2': 'Arris', '001DD0': 'Arris', '3C754A': 'Arris', '74852A': 'Arris', '9C3426': 'Arris',
  // Linksys / Belkin
  '0014BF': 'Linksys', '001839': 'Linksys', '001A70': 'Linksys', '20AA4B': 'Linksys',
  '48F8B3': 'Linksys', 'C05627': 'Linksys',
  '001150': 'Belkin', '001CDF': 'Belkin', '08863B': 'Belkin', '94103E': 'Belkin', 'EC1A59': 'Belkin',
  // Tenda
  '00B00C': 'Tenda', 'C83A35': 'Tenda', '0495E6': 'Tenda', '502B73': 'Tenda',
  // Enterprise APs
  '000A41': 'Cisco', '001A2F': 'Cisco', '00260B': 'Cisco', '588D09': 'Cisco', '000BBE': 'Cisco',
  '000B86': 'Aruba', '186472': 'Aruba', '6CF37F': 'Aruba', '94B40F': 'Aruba', '24DEC6': 'Aruba',
  '001D2E': 'Ruckus', '24792A': 'Ruckus', '2CE6CC': 'Ruckus', '589396': 'Ruckus', 'C0C520': 'Ruckus',
  '00090F': 'Fortinet', '085B0E': 'Fortinet', '906CAC': 'Fortinet',
  '2C2131': 'Juniper/Mist', '5C5B35': 'Juniper/Mist', 'F01C2D': 'Juniper/Mist',
  '000456': 'Cambium', '58C17A': 'Cambium',
  // Mesh / consumer platforms
  '001A11': 'Google', '3C286D': 'Google', '6CADF8': 'Google', 'F4F5E8': 'Google', '30FD38': 'Google',
  '00FC8B': 'Amazon (eero)', '6837E9': 'Amazon (eero)', '74C246': 'Amazon (eero)',
  'F08173': 'Amazon (eero)', 'AC63BE': 'Amazon (eero)',
  // Phone hotspots
  '0012FB': 'Samsung', '5C0A5B': 'Samsung', '8C71F8': 'Samsung', 'E8508B': 'Samsung',
  // Espressif — an ESP32 acting as an AP
  '240AC4': 'Espressif', '3C71BF': 'Espressif', '807D3A': 'Espressif', 'A4CF12': 'Espressif',
  '7CDFA1': 'Espressif', '140808': 'Espressif', 'B4E62D': 'Espressif', '8CAAB5': 'Espressif',
};

let table = null;
let source = null;

// Priority: a CSV supplied at runtime (local server) > the generated bundle
// (committed, available on Vercel) > the curated table above.
function build(dataDir) {
  const csv = dataDir ? `${dataDir}/oui.csv` : null;
  if (csv && existsSync(csv)) {
    try {
      const map = Object.create(null);
      for (const line of readFileSync(csv, 'utf8').split('\n')) {
        // MA-L,001122,Vendor Name,Address…   — the name may be quoted.
        const m = line.match(/^MA-L,([0-9A-Fa-f]{6}),(?:"((?:[^"]|"")*)"|([^,]*))/);
        if (!m) continue;
        const name = (m[2] ? m[2].replace(/""/g, '"') : m[3] || '').trim();
        if (name) map[m[1].toUpperCase()] = name;
      }
      table = { ...FALLBACK, ...map };
      source = `IEEE MA-L registry, ${Object.keys(map).length} entries (oui.csv)`;
      return;
    } catch (err) {
      // fall through to the bundle
      source = `oui.csv unreadable: ${err.message}`;
    }
  }

  const bundledCount = Object.keys(BUNDLED).length;
  if (bundledCount) {
    table = { ...FALLBACK, ...BUNDLED };
    source = `IEEE MA-L registry, ${bundledCount} entries (bundled)`;
  } else {
    table = FALLBACK;
    source = `built-in table, ${Object.keys(FALLBACK).length} entries ` +
             `(run "npm run fetch-oui" for the full IEEE registry)`;
  }
}

/** Local server calls this with its data directory; serverless never needs to. */
export function initOui(dataDir) {
  build(dataDir);
  return source;
}

export function ouiSource() {
  if (!table) build(null);
  return source;
}

/** Locally-administered MACs are randomised, not vendor-assigned. */
export function isLocallyAdministered(bssid) {
  const first = parseInt(bssid.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}

export function lookupVendor(bssid) {
  if (!table) build(null);
  if (!bssid) return '';
  const key = bssid.replace(/[:-]/g, '').toUpperCase().slice(0, 6);
  if (key.length < 6) return '';
  if (isLocallyAdministered(bssid)) return 'randomised MAC';
  return table[key] || '';
}
