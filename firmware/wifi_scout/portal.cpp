#include "portal.h"
#include "config.h"
#include "settings.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>

static WebServer server(80);
static DNSServer dns;
static bool      s_saved = false;

// Escape for interpolation into HTML attribute values.
static String esc(const char* s) {
  String out;
  for (const char* p = s; *p; p++) {
    switch (*p) {
      case '&':  out += "&amp;";  break;
      case '<':  out += "&lt;";   break;
      case '>':  out += "&gt;";   break;
      case '"':  out += "&quot;"; break;
      case '\'': out += "&#39;";  break;
      default:   out += *p;       break;
    }
  }
  return out;
}

static const char PAGE_CSS[] PROGMEM = R"CSS(
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
     background:#0e1116;color:#e6edf3}
.wrap{max-width:460px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8b949e;font-size:13px;margin:0 0 24px}
label{display:block;margin:16px 0 6px;font-size:13px;font-weight:600;color:#c9d1d9}
input,select{width:100%;padding:11px 12px;border-radius:8px;border:1px solid #30363d;
     background:#161b22;color:#e6edf3;font-size:16px}
input:focus,select:focus{outline:none;border-color:#2f81f7}
button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#238636;
     color:#fff;font-size:16px;font-weight:600}
button:active{background:#1a612a}
.hint{color:#8b949e;font-size:12px;margin-top:5px}
.ok{background:#132e1a;border:1px solid #238636;padding:14px;border-radius:8px;margin-bottom:16px}
.mac{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#8b949e}
)CSS";

static String buildPage() {
  String h;
  h.reserve(6000);
  h += F("<!doctype html><html><head><meta charset='utf-8'>"
         "<meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<title>WiFi Scout setup</title><style>");
  h += FPSTR(PAGE_CSS);
  h += F("</style></head><body><div class='wrap'>"
         "<h1>WiFi Scout setup</h1>"
         "<p class='sub'>Device <span class='mac'>");
  h += deviceMac();
  h += F("</span> &middot; firmware ");
  h += F(FW_VERSION);
  h += F("</p><form method='POST' action='/save'>");

  // --- network picker -------------------------------------------------------
  h += F("<label for='ssid'>Hotspot network</label>"
         "<input list='nets' id='ssid' name='ssid' required maxlength='32' value='");
  h += esc(g_cfg.wifi_ssid);
  h += F("' placeholder='Your phone hotspot name'><datalist id='nets'>");

  int n = WiFi.scanComplete();
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0) continue;
    h += F("<option value='");
    h += esc(s.c_str());
    h += F("'>");
  }
  h += F("</datalist>"
         "<p class='hint'>2.4 GHz only &mdash; this chip cannot join a 5 GHz hotspot.</p>");

  h += F("<label for='pass'>Hotspot password</label>"
         "<input type='password' id='pass' name='pass' maxlength='64' value='");
  h += esc(g_cfg.wifi_pass);
  h += F("'>");

  h += F("<label for='server'>Dashboard URL</label>"
         "<input id='server' name='server' required maxlength='128' value='");
  h += esc(g_cfg.server);
  h += F("' placeholder='https://my-scout.vercel.app'>"
         "<p class='hint'>Your Vercel deployment, or http://&lt;laptop-ip&gt;:8080 "
         "for the local test server.</p>");

  h += F("<label for='token'>Upload token</label>"
         "<input id='token' name='token' maxlength='64' value='");
  h += esc(g_cfg.token);
  h += F("' placeholder='matches SCOUT_TOKEN'>"
         "<p class='hint'>Must match the SCOUT_TOKEN environment variable on the "
         "server. Leave blank for the local test server.</p>");

  h += F("<label for='name'>Device label</label>"
         "<input id='name' name='name' maxlength='32' value='");
  h += esc(g_cfg.device_name);
  h += F("'>");

  h += F("<label for='interval'>Scan every</label><select id='interval' name='interval'>");
  const uint32_t opts[]  = {60, 120, 300, 600, 1800};
  const char*    labels[] = {"1 minute", "2 minutes", "5 minutes",
                             "10 minutes", "30 minutes"};
  for (int i = 0; i < 5; i++) {
    h += F("<option value='");
    h += String(opts[i]);
    h += F("'");
    if (g_cfg.interval_ms / 1000UL == opts[i]) h += F(" selected");
    h += F(">");
    h += labels[i];
    h += F("</option>");
  }
  h += F("</select>");

  h += F("<button type='submit'>Save &amp; restart</button>"
         "</form></div></body></html>");
  return h;
}

static void handleRoot()  { server.send(200, "text/html", buildPage()); }

static void handleSave() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  String srv  = server.arg("server");
  String tok  = server.arg("token");
  String name = server.arg("name");
  uint32_t iv = (uint32_t)server.arg("interval").toInt();

  if (ssid.length() == 0 || srv.length() == 0) {
    server.send(400, "text/plain", "Network name and server URL are required.");
    return;
  }
  // Accept a bare host:port and normalise it to a URL. A bare IPv4 literal is
  // almost always the local test server on plain HTTP; a real hostname is a
  // hosted dashboard, and those redirect plain HTTP to TLS.
  if (!srv.startsWith("http://") && !srv.startsWith("https://")) {
    bool lanHost = srv.startsWith("localhost");
    if (!lanHost) {
      int dots = 0;
      bool digitsOnly = true, sawDigit = false;
      for (int i = 0; i < (int)srv.length(); i++) {
        char c = srv[i];
        if (c == ':' || c == '/') break;          // stop at port or path
        if (c == '.')                    dots++;
        else if (c >= '0' && c <= '9')   sawDigit = true;
        else                           { digitsOnly = false; break; }
      }
      lanHost = digitsOnly && sawDigit && dots == 3;
    }
    srv = (lanHost ? "http://" : "https://") + srv;
  }
  while (srv.endsWith("/")) srv.remove(srv.length() - 1);

  strncpy(g_cfg.wifi_ssid, ssid.c_str(), sizeof(g_cfg.wifi_ssid) - 1);
  strncpy(g_cfg.wifi_pass, pass.c_str(), sizeof(g_cfg.wifi_pass) - 1);
  strncpy(g_cfg.server,    srv.c_str(),  sizeof(g_cfg.server) - 1);
  strncpy(g_cfg.token,     tok.c_str(),  sizeof(g_cfg.token) - 1);
  if (name.length()) strncpy(g_cfg.device_name, name.c_str(), sizeof(g_cfg.device_name) - 1);
  g_cfg.interval_ms = (iv >= 30 ? iv : 60) * 1000UL;
  settingsSave();

  String h = F("<!doctype html><html><head><meta charset='utf-8'>"
               "<meta name='viewport' content='width=device-width,initial-scale=1'>"
               "<title>Saved</title><style>");
  h += FPSTR(PAGE_CSS);
  h += F("</style></head><body><div class='wrap'><div class='ok'><b>Settings saved.</b><br>"
         "The device is restarting and will start reporting to your dashboard.</div>"
         "<p class='sub'>To change these later, hold the BOOT button for 3 seconds "
         "while powering on.</p></div></body></html>");
  server.send(200, "text/html", h);
  s_saved = true;
}

// iOS, Android and Windows each probe a well-known URL to decide whether a
// network is behind a captive portal. Redirecting everything makes the setup
// page pop up automatically on join.
static void handleNotFound() {
  server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  server.send(302, "text/plain", "");
}

void runConfigPortal() {
  String apName = String(PORTAL_AP_PREFIX) + deviceShortId();

  // Scan first so the form can offer a network list, then switch to AP mode.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  delay(100);
  WiFi.scanNetworks(false /*async*/, false /*show_hidden*/);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str(), PORTAL_AP_PASS);
  delay(300);

  IPAddress ip = WiFi.softAPIP();
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", ip);

  server.on("/",                handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/generate_204",    handleNotFound);   // Android
  server.on("/hotspot-detect.html", handleNotFound);  // iOS / macOS
  server.on("/ncsi.txt",        handleNotFound);   // Windows
  server.onNotFound(handleNotFound);
  server.begin();

  Serial.println();
  Serial.println(F("=========================================="));
  Serial.println(F("  CONFIG PORTAL ACTIVE"));
  Serial.printf ("  Join WiFi : %s\n", apName.c_str());
  Serial.printf ("  Password  : %s\n", PORTAL_AP_PASS);
  Serial.printf ("  Then open : http://%s/\n", ip.toString().c_str());
  Serial.println(F("=========================================="));

  uint32_t start = millis();
  while (!s_saved) {
    dns.processNextRequest();
    server.handleClient();

    // Slow heartbeat blink so it is obvious the device is waiting for setup.
    digitalWrite(LED_PIN, (millis() / 500) % 2);

    if (PORTAL_TIMEOUT_MS && millis() - start > PORTAL_TIMEOUT_MS) {
      Serial.println(F("[portal] timed out, restarting"));
      ESP.restart();
    }
    delay(2);
  }

  delay(1200);                 // let the browser receive the confirmation page
  server.stop();
  dns.stop();
  ESP.restart();
}
