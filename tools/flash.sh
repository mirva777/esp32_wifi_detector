#!/usr/bin/env bash
# flash.sh — compile and upload the WiFi Scout firmware to a connected ESP32.
#
#   tools/flash.sh              auto-detect the serial port
#   tools/flash.sh /dev/cu.xyz  use a specific port
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware/wifi_scout"
FQBN="esp32:esp32:esp32"

if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "arduino-cli not found. Install it with:  brew install arduino-cli" >&2
  exit 1
fi

PORT="${1:-}"
if [ -z "$PORT" ]; then
  # CH340 and CP210x adapters show up under these names on macOS.
  PORT="$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* \
          /dev/cu.usbmodem* 2>/dev/null | head -n1 || true)"
fi

if [ -z "$PORT" ]; then
  echo "No ESP32 serial port found." >&2
  echo >&2
  echo "Check that:" >&2
  echo "  * the board is plugged in with a DATA cable, not a charge-only one" >&2
  echo "  * it is connected directly to the Mac rather than through a hub" >&2
  echo "  * 'ls /dev/cu.*' lists something like cu.usbserial-0001" >&2
  exit 1
fi

echo "Port   : $PORT"
echo "Board  : $FQBN"
echo "Sketch : $SKETCH"
echo

echo "==> Compiling"
arduino-cli compile --fqbn "$FQBN" "$SKETCH"

echo
echo "==> Uploading"
# Some clone boards need the BOOT button held during the initial handshake.
arduino-cli upload --fqbn "$FQBN" --port "$PORT" "$SKETCH"

echo
echo "Done. Watch the device with:  tools/monitor.sh $PORT"
