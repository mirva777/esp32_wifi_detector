// portal.h — SoftAP captive portal for first-run / re-configuration.
#pragma once

// Brings up an open-to-join WPA2 SoftAP and serves a configuration form.
// Blocks until the user saves settings, then reboots the device.
void runConfigPortal();
