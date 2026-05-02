#!/usr/bin/env bash
# cal-full.sh — interactive full cal sequence on a single CT.
# Runs: clear-all → offset → power-offset → gain, prompting at the right moments.
#
# Usage:
#   ./cal-full.sh <channel>
#
# Required env:
#   HA_URL           Base URL of your Home Assistant install
#   HA_TOKEN         Long-lived access token
#   DEVICE_PREFIX    HA entity prefix for your meter (e.g. energy_meter_58d5d4)
#
# Channel name = the lowercase, underscored form of your ct*_name in YAML.
# Edit the case block below to map your own channel names to chip groups.
#
# At the prompts you only type one thing: the live amps reading from your
# clamp meter when the load is steady. Everything else fires automatically.

set -euo pipefail

: "${HA_URL:?HA_URL is required}"
: "${HA_TOKEN:?HA_TOKEN is required}"
: "${DEVICE_PREFIX:?DEVICE_PREFIX is required}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <channel>" >&2; exit 1
fi

CH="$1"

# === EDIT THIS for your panel (must match the table in cal-ct.sh) =========
case "$CH" in
  l1_mains|l2_mains|ct3)                             GROUP="meter_1_3";    VSUF="1" ;;
  ct4|ct5|ct6)                                       GROUP="meter_4_6";    VSUF="2" ;;
  ct7|ct8|ct9)                                       GROUP="addon1_7_9";   VSUF="1" ;;
  ct10|ct11|ct12)                                    GROUP="addon1_10_12"; VSUF="2" ;;
  *) echo "Unknown channel: $CH (edit the case block in $0)" >&2; exit 2 ;;
esac
# =========================================================================

HDR=(-H "Authorization: Bearer ${HA_TOKEN}" -H "Content-Type: application/json")

set_num()  { curl -sS -m 5 -X POST "${HDR[@]}" -d "{\"entity_id\":\"$1\",\"value\":$2}" "${HA_URL}/api/services/number/set_value" >/dev/null; }
press()    { curl -sS -m 5 -X POST "${HDR[@]}" -d "{\"entity_id\":\"$1\"}"             "${HA_URL}/api/services/button/press"  >/dev/null; }
state()    { curl -sS -m 5 "${HDR[@]}" "${HA_URL}/api/states/$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',''))"; }

REF_V="number.${DEVICE_PREFIX}_${GROUP}_ref_v_${VSUF}"
REF_I="number.${DEVICE_PREFIX}_${CH}_ref_current"
B_OFFSET="button.${DEVICE_PREFIX}_1_run_${GROUP}_offset_cal"
B_POFF="button.${DEVICE_PREFIX}_2_run_${GROUP}_power_offset_cal"
B_GAIN="button.${DEVICE_PREFIX}_3_run_${GROUP}_gain_cal"
B_CLR1="button.${DEVICE_PREFIX}_z1_clear_${GROUP}_offset_cal"
B_CLR2="button.${DEVICE_PREFIX}_z2_clear_${GROUP}_power_offset_cal"
B_CLR3="button.${DEVICE_PREFIX}_z3_clear_${GROUP}_gain_cal"
A_SENS="sensor.${DEVICE_PREFIX}_${CH}_amps"
W_SENS="sensor.${DEVICE_PREFIX}_${CH}_watts"

VOLT=$(state "sensor.${DEVICE_PREFIX}_voltage_1")

echo "Channel: $CH (chip $GROUP, V$VSUF)"
echo "Voltage 1 (live): ${VOLT} V"
echo

echo "==> Step 1: clearing prior cal on chip $GROUP"
press "$B_CLR1"; press "$B_CLR2"; press "$B_CLR3"
sleep 2
echo "    cleared."
echo

echo "==> Step 2: offset cal (NO LOAD on any channel of chip $GROUP)"
echo "    Turn OFF all loads on this chip's CTs."
read -r -p "    Press Enter when all OFF... " _
set_num "$REF_V" "$VOLT"
press "$B_OFFSET";  echo "    offset cal pressed";    sleep 3
press "$B_POFF";    echo "    power-offset cal pressed"; sleep 3
echo

echo "==> Step 3: gain cal (steady reference load on $CH)"
echo "    Turn ON the load. When your clamp meter shows a STEADY current,"
read -r -p "    type the amps value and press Enter: " AMPS
set_num "$REF_I" "$AMPS"
press "$B_GAIN"
echo "    gain cal pressed at $(date +%H:%M:%S)"
sleep 3

A=$(state "$A_SENS"); W=$(state "$W_SENS")
echo
printf "Post-cal: %s = %.4f A / %.3f W (you typed %s A)\n" "$CH" "$A" "$W" "$AMPS"
