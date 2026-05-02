#!/usr/bin/env bash
# cal.sh — fast mains gain calibration via the ESPHome web server (no HA needed).
#
# Talks directly to the energy meter's built-in HTTP server. Sets ref V on the
# meter_1-3 chip, sets ref currents on the L1/L2 mains channels, fires the
# gain-cal button, and reads back post-cal sensor values.
#
# Usage:
#   DEVICE_IP=<ip> ./cal.sh <L1_amps> <L2_amps> [voltage]
#
# Required env:
#   DEVICE_IP        ESPHome device IP or hostname (e.g. 192.168.1.50)
#
# Optional env (override only if your YAML uses different ct1/ct2 names):
#   L1_ENTITY        Slug for ct1 ref-current number     (default: l1_mains)
#   L2_ENTITY        Slug for ct2 ref-current number     (default: l2_mains)
#   REF_V_ENTITY     Slug for the chip ref-voltage entry (default: meter_1-3_ref_v_1)
#   GAIN_BTN         Slug for the chip gain-cal button   (default: 3__run_meter_1-3_gain_cal)
#
# The slugs above are derived from your YAML substitutions. ESPHome lowercases
# the friendly name and replaces spaces with underscores, so "L1 Mains" becomes
# "l1_mains". If you rename your mains, override the env vars.
#
# Run this WHILE a stable load is steady. Speed matters — load fluctuations
# corrupt the calibration if the chip's "currently measured" diverges from
# your reference values mid-cal.

set -euo pipefail

if [[ -z "${DEVICE_IP:-}" ]]; then
  echo "ERROR: DEVICE_IP is not set." >&2
  echo "Example: DEVICE_IP=192.168.1.50 $0 22.5 24.8" >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <L1_amps> <L2_amps> [voltage=119.5]" >&2
  echo "Example: DEVICE_IP=192.168.1.50 $0 22.5 24.8" >&2
  exit 1
fi

L1_AMPS="$1"
L2_AMPS="$2"
VOLTAGE="${3:-119.5}"

L1_ENTITY="${L1_ENTITY:-l1_mains}"
L2_ENTITY="${L2_ENTITY:-l2_mains}"
REF_V_ENTITY="${REF_V_ENTITY:-meter_1-3_ref_v_1}"
GAIN_BTN="${GAIN_BTN:-3__run_meter_1-3_gain_cal}"

post() {
  curl -sS -m 5 -X POST -d "" "$1" -o /dev/null -w "%{http_code}"
}

echo "==> Device: http://${DEVICE_IP}"
echo "==> Setting Ref V = ${VOLTAGE} V"
echo "    HTTP $(post "http://${DEVICE_IP}/number/${REF_V_ENTITY}/set?value=${VOLTAGE}")"
echo "==> Setting ${L1_ENTITY} Ref Current = ${L1_AMPS} A"
echo "    HTTP $(post "http://${DEVICE_IP}/number/${L1_ENTITY}_ref_current/set?value=${L1_AMPS}")"
echo "==> Setting ${L2_ENTITY} Ref Current = ${L2_AMPS} A"
echo "    HTTP $(post "http://${DEVICE_IP}/number/${L2_ENTITY}_ref_current/set?value=${L2_AMPS}")"
echo
echo "==> Pressing gain-cal button: ${GAIN_BTN}"
echo "    HTTP $(post "http://${DEVICE_IP}/button/${GAIN_BTN}/press")"
echo
echo "==> Waiting 3s for cal to apply..."
sleep 3
echo
echo "==> Reading back post-cal sensor values:"
LOG=$(mktemp)
curl -sS -m 5 "http://${DEVICE_IP}/events" 2>/dev/null > "${LOG}" &
CURL_PID=$!
sleep 4
kill "${CURL_PID}" 2>/dev/null || true
wait 2>/dev/null || true

grep -E '"sensor/' "${LOG}" \
  | head -20 \
  | python3 -c '
import sys, json, re
seen = set()
for line in sys.stdin:
    m = re.search(r"data:\s*({.*})", line)
    if not m:
        continue
    try:
        d = json.loads(m.group(1))
    except json.JSONDecodeError:
        continue
    name = d.get("name", "")
    if name in seen or not name:
        continue
    seen.add(name)
    state = d.get("state", "")
    print(f"    {name:30s} {state:>15s}")
'

rm -f "${LOG}"
echo
echo "Done. Compare to your clamp-meter readings:  L1=${L1_AMPS} A  L2=${L2_AMPS} A"
