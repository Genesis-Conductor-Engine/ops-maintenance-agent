#!/usr/bin/env bash
# Install ops-maintenance-agent systemd units for post-boot/crash automation.
# Copies units, reloads systemd, enables scheduled services. Does NOT reboot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="${ROOT}/systemd"
UNIT_DST="/etc/systemd/system"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: install-automation.sh must run as root" >&2
  exit 1
fi

echo "[install] copying units from ${UNIT_SRC} → ${UNIT_DST}"
shopt -s nullglob
copied=0
for f in "${UNIT_SRC}"/*.service "${UNIT_SRC}"/*.timer; do
  base="$(basename "$f")"
  cp -f "$f" "${UNIT_DST}/${base}"
  echo "  + ${base}"
  copied=$((copied + 1))
done
shopt -u nullglob

if [[ "$copied" -eq 0 ]]; then
  echo "ERROR: no .service/.timer files found in ${UNIT_SRC}" >&2
  exit 1
fi

echo "[install] systemctl daemon-reload"
systemctl daemon-reload

ENABLE_UNITS=(
  ops-post-boot.service
  ops-maintenance-http.service
  ops-maintenance-cycle.timer
  ops-crash-analyze.timer
)

echo "[install] enable units"
for u in "${ENABLE_UNITS[@]}"; do
  systemctl enable "$u"
  echo "  enabled: $u"
done

if systemctl is-active --quiet ops-maintenance-http.service; then
  echo "[install] ops-maintenance-http already active"
else
  echo "[install] starting ops-maintenance-http"
  systemctl start ops-maintenance-http.service
fi

# Timers must be started on a live host (enable alone only wires WantedBy for next boot)
for t in ops-maintenance-cycle.timer ops-crash-analyze.timer; do
  if systemctl is-active --quiet "$t"; then
    echo "[install] $t already active"
  else
    echo "[install] starting $t"
    systemctl start "$t"
  fi
done

echo ""
echo "[install] unit status"
for u in \
  ops-post-boot.service \
  ops-maintenance-http.service \
  ops-maintenance-cycle.timer \
  ops-crash-analyze.timer \
  ops-crash-analyze.service \
  ops-maintenance-cycle.service
do
  if systemctl cat "$u" &>/dev/null; then
    en="$(systemctl is-enabled "$u" 2>/dev/null || true)"
    ac="$(systemctl is-active "$u" 2>/dev/null || true)"
    en="${en:-n/a}"
    ac="${ac:-n/a}"
    printf "  %-36s enabled=%-12s active=%s\n" "$u" "$en" "$ac"
  else
    printf "  %-36s (missing)\n" "$u"
  fi
done

echo ""
echo "[install] timers"
systemctl list-timers --all 'ops-*' --no-pager 2>/dev/null || \
  systemctl list-timers --all --no-pager | grep -E 'ops-|NEXT' || true

echo ""
echo "[install] done (no reboot performed)"
