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
  # Never install example units as live services
  if [[ "$base" == *.example ]]; then
    echo "  ~ skip example: ${base}"
    continue
  fi
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

# Inference meter (R01) — enable when unit is installed
if [[ -f "${UNIT_DST}/ops-inference-meter.service" ]]; then
  systemctl enable ops-inference-meter.service
  echo "  enabled: ops-inference-meter.service"
  if systemctl is-active --quiet ops-inference-meter.service; then
    echo "[install] ops-inference-meter already active"
  else
    echo "[install] starting ops-inference-meter"
    systemctl start ops-inference-meter.service || \
      echo "[install] WARN: ops-inference-meter failed to start (check journal)" >&2
  fi
else
  echo "[install] skip ops-inference-meter (unit missing after copy)"
fi

# Named inference tunnel — enable only when credentials + config exist
CF_CREDS="/home/diamondnode/.cloudflared/af9cf2e4-0119-4f2a-ba66-19b8c8a23080.json"
CF_CFG="${ROOT}/config/cloudflared-inference.yml"
if [[ -f "${UNIT_DST}/cloudflared-inference.service" && -f "${CF_CREDS}" && -f "${CF_CFG}" ]]; then
  systemctl enable cloudflared-inference.service
  echo "  enabled: cloudflared-inference.service"
  if systemctl is-active --quiet cloudflared-inference.service; then
    echo "[install] cloudflared-inference already active"
  else
    echo "[install] starting cloudflared-inference"
    systemctl start cloudflared-inference.service || \
      echo "[install] WARN: cloudflared-inference failed to start (check journal)" >&2
  fi
else
  echo "[install] skip cloudflared-inference (need unit + credentials + ${CF_CFG})"
fi

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
  ops-maintenance-cycle.service \
  ops-inference-meter.service \
  cloudflared-inference.service
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
