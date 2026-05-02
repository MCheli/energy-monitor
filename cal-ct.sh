#!/usr/bin/env bash
# cal-ct.sh — fast per-CT gain calibration via the Home Assistant API.
#
# Reads Voltage 1 live from the meter, sets Ref V and Ref Current for the
# given channel, fires the chip-level gain-cal button, and prints post-cal
# state.
#
# Usage:
#   ./cal-ct.sh <channel> <amps> [--clear]
#
# Required env:
#   HA_URL           Base URL of your Home Assistant install (e.g. http://homeassistant.local:8123)
#   HA_TOKEN         A long-lived access token from your HA profile page
#   DEVICE_PREFIX    The HA entity prefix for your meter, e.g. "energy_meter_58d5d4"
#                    (look at any sensor entity ID in HA — everything before "_voltage_1")
#
# Channel name = the lowercase, underscored form of your ct*_name in YAML.
# "Hot Water Heater" → "hot_water_heater". Edit the case block below to map
# your own channel names to chip groups.
#
# Example:
#   HA_URL=http://homeassistant.local:8123 \
#   HA_TOKEN=eyJhbG... \
#   DEVICE_PREFIX=energy_meter_a1b2c3 \
#     ./cal-ct.sh dryer 23.8

set -euo pipefail

: "${HA_URL:?HA_URL is required (e.g. http://homeassistant.local:8123)}"
: "${HA_TOKEN:?HA_TOKEN is required (long-lived access token)}"
: "${DEVICE_PREFIX:?DEVICE_PREFIX is required (e.g. energy_meter_58d5d4)}"

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

if [[ $# -lt 2 ]]; then usage; exit 1; fi

CH="$1"; AMPS="$2"; CLEAR="${3:-}"

# === EDIT THIS for your panel ============================================
# Map each of your circuit-name slugs to its chip group + voltage-ref index.
# Chip groups: meter_1_3 (CT1-3), meter_4_6 (CT4-6), addon1_7_9 (CT7-9), addon1_10_12 (CT10-12).
# VSUF: voltage-ref number on the chip — 1 for meter_1_3 / addon1_7_9, 2 for meter_4_6 / addon1_10_12.
case "$CH" in
  # main board, CTs 1-3
  l1_mains|l2_mains|ct3)                             GROUP="meter_1_3";    VSUF="1" ;;
  # main board, CTs 4-6
  ct4|ct5|ct6)                                       GROUP="meter_4_6";    VSUF="2" ;;
  # add-on board, CTs 7-9
  ct7|ct8|ct9)                                       GROUP="addon1_7_9";   VSUF="1" ;;
  # add-on board, CTs 10-12
  ct10|ct11|ct12)                                    GROUP="addon1_10_12"; VSUF="2" ;;
  *) echo "Unknown channel: $CH (edit the case block in $0)" >&2; usage; exit 2 ;;
esac
# =========================================================================

HDR=(-H "Authorization: Bearer ${HA_TOKEN}" -H "Content-Type: application/json")

api_set_number() {
  curl -sS -m 5 -X POST "${HDR[@]}" \
    -d "{\"entity_id\":\"$1\",\"value\":$2}" \
    "${HA_URL}/api/services/number/set_value" >/dev/null
}
api_press_button() {
  curl -sS -m 5 -X POST "${HDR[@]}" \
    -d "{\"entity_id\":\"$1\"}" \
    "${HA_URL}/api/services/button/press" >/dev/null
}
api_get_state() {
  curl -sS -m 5 "${HDR[@]}" "${HA_URL}/api/states/$1" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',''))"
}

REF_V="number.${DEVICE_PREFIX}_${GROUP}_ref_v_${VSUF}"
REF_I="number.${DEVICE_PREFIX}_${CH}_ref_current"
GAIN_BTN="button.${DEVICE_PREFIX}_3_run_${GROUP}_gain_cal"
CLEAR_BTN="button.${DEVICE_PREFIX}_z3_clear_${GROUP}_gain_cal"
AMPS_SENS="sensor.${DEVICE_PREFIX}_${CH}_amps"
WATTS_SENS="sensor.${DEVICE_PREFIX}_${CH}_watts"

VOLT=$(api_get_state "sensor.${DEVICE_PREFIX}_voltage_1")
echo "channel:   $CH (chip $GROUP, V$VSUF)"
echo "voltage:   ${VOLT} V (live)"
echo "ref I:     ${AMPS} A"

if [[ "$CLEAR" == "--clear" ]]; then
  echo "-> clearing gain cal"
  api_press_button "$CLEAR_BTN"
  sleep 2
fi

api_set_number "$REF_V" "$VOLT"
api_set_number "$REF_I" "$AMPS"
api_press_button "$GAIN_BTN"
echo "-> cal pressed at $(date +%H:%M:%S)"

sleep 3
A=$(api_get_state "$AMPS_SENS")
W=$(api_get_state "$WATTS_SENS")
printf "post-cal:  %s = %.4f A / %.3f W\n" "$CH" "$A" "$W"
