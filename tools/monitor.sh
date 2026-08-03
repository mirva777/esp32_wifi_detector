#!/usr/bin/env bash
# monitor.sh — watch the ESP32 serial console at 115200 baud.
#
#   tools/monitor.sh              auto-detect the port
#   tools/monitor.sh /dev/cu.xyz  use a specific port
set -euo pipefail

PORT="${1:-}"
if [ -z "$PORT" ]; then
  PORT="$(ls /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* \
          /dev/cu.usbmodem* 2>/dev/null | head -n1 || true)"
fi

if [ -z "$PORT" ]; then
  echo "No ESP32 serial port found. Is the board plugged in?" >&2
  exit 1
fi

echo "Monitoring $PORT at 115200 baud — Ctrl-C to stop."
exec arduino-cli monitor --port "$PORT" --config baudrate=115200
