#!/bin/bash
# Wrapper around /root/setup-kimi-mobile-replies.sh + gateway ensure + reachability.
# Usage:
#   ./scripts/setup-kimi-bridge.sh              # ensure gateway only (no moonshot key)
#   ./scripts/setup-kimi-bridge.sh sk-XXXX      # full mobile replies setup with Moonshot key
set -euo pipefail
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [ "${1:-}" != "" ]; then
  echo "Running full setup-kimi-mobile-replies.sh with provided key…"
  /root/setup-kimi-mobile-replies.sh "$1"
else
  echo "No Moonshot key provided — ensuring openclaw-gateway + Kimi IM path only."
  systemctl enable openclaw-gateway >/dev/null 2>&1 || true
  systemctl start openclaw-gateway
  sleep 4
fi

echo ""
echo "=== Reachability ==="
kimi-claw-reachability-check || true
kimiim-cli me || true
systemctl is-active openclaw-gateway ollama
echo ""
echo "Mobile path: Kimi app → chat with OpenClaw-moY"
echo "Ops updates: cd /root/ops-maintenance-agent && node scripts/kimi-update.mjs"
