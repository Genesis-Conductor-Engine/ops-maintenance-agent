#!/usr/bin/env bash
# Write public inference base URL after tunnel is configured.
# Named tunnel path is deterministic. Quick-tunnel fallback parses cloudflared logs
# for a trycloudflare.com URL (no tokens/secrets are written).
#
# Runtime artifacts go under reports/ only (avoids dirtying committed config/ on every restart).
# Optional: set INFERENCE_WRITE_CONFIG=1 to also refresh config/inference-public.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTS="${ROOT}/reports"
CONFIG_JSON="${ROOT}/config/inference-public.json"
RUNTIME_JSON="${REPORTS}/inference-public.json"
URL_TXT="${REPORTS}/inference-public-url.txt"
LOG_HINT="${1:-}"

mkdir -p "${REPORTS}"

# Prefer named-tunnel hostname (stable). Override with INFERENCE_PUBLIC_BASE_URL if set.
NAMED_URL="${INFERENCE_PUBLIC_BASE_URL:-https://inference.yennefer.quest}"
MODE="named-tunnel"
PUBLIC_URL="${NAMED_URL}"

# Optional: if invoked with a log path, parse trycloudflare URL (quick-tunnel fallback).
if [[ -n "${LOG_HINT}" && -f "${LOG_HINT}" ]]; then
  FOUND="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "${LOG_HINT}" 2>/dev/null | tail -1 || true)"
  if [[ -n "${FOUND}" ]]; then
    PUBLIC_URL="${FOUND}"
    MODE="quick-tunnel"
  fi
fi

# If named mode but operator wants log-derived URL only when INFERENCE_USE_QUICK_TUNNEL=1
if [[ "${INFERENCE_USE_QUICK_TUNNEL:-0}" == "1" ]]; then
  LOG_FILE="${INFERENCE_QUICK_TUNNEL_LOG:-/var/log/cloudflared-inference-quick.log}"
  if [[ -f "${LOG_FILE}" ]]; then
    FOUND="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "${LOG_FILE}" 2>/dev/null | tail -1 || true)"
    if [[ -n "${FOUND}" ]]; then
      PUBLIC_URL="${FOUND}"
      MODE="quick-tunnel"
    fi
  fi
fi

# Strip trailing slash
PUBLIC_URL="${PUBLIC_URL%/}"

PAYLOAD=$(cat <<EOF
{
  "service": "diamondnode-inference-meter",
  "stream": "R01",
  "public_base_url": "${PUBLIC_URL}",
  "preferred_hostname": "inference.genesisconductor.io",
  "active_hostname": "${PUBLIC_URL#https://}",
  "mode": "${MODE}",
  "local_origin": "http://127.0.0.1:8792",
  "endpoints": {
    "health": "${PUBLIC_URL}/health",
    "pricing": "${PUBLIC_URL}/pricing",
    "chat_completions": "${PUBLIC_URL}/v1/chat/completions"
  },
  "notes": "Named tunnel DNS zone follows origin cert (yennefer.quest). Point inference.genesisconductor.io CNAME to the same tunnel when CF zone access allows. Never store tunnel tokens in this file. Admin routes are localhost-only.",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

umask 022
printf '%s\n' "${PUBLIC_URL}" > "${URL_TXT}"
printf '%s\n' "${PAYLOAD}" > "${RUNTIME_JSON}"

echo "[inference-public] wrote ${URL_TXT} → ${PUBLIC_URL} (${MODE})"
echo "[inference-public] wrote ${RUNTIME_JSON}"

if [[ "${INFERENCE_WRITE_CONFIG:-0}" == "1" ]]; then
  printf '%s\n' "${PAYLOAD}" > "${CONFIG_JSON}"
  echo "[inference-public] wrote ${CONFIG_JSON} (INFERENCE_WRITE_CONFIG=1)"
fi
