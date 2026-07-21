# ops-maintenance-agent

Diamondnode maintenance control plane combining:

| Skill / command | Role |
|-----------------|------|
| `/verification` | End-to-end service + Kimi + gh flow checks |
| `/troubleshooting` | Chrome DevTools MCP path (browser layer when needed) |
| `/build-agent` | Cloudflare `MaintenanceAgent` DO with cron schedule |
| `/pr-babysit all` | Inventory all open PRs; flag CI/review/conflicts |
| `/subagent-driven-development` | Parallel domain work for scaffolds |
| `/sentry-svelte-sdk` | SvelteKit hooks under `svelte-hooks/` |
| `/axiom-alerting` | Monitor JSON under `monitors/` |
| `/building-dashboards` | Dashboard blueprint under `dashboard-spec/` |
| `/workflow` | Durable `maintenanceWorkflow` (Vercel WDK) |
| `setup-kimi-mobile-replies.sh` | Kimi mobile updates via OpenClaw-moY |

## Quick start (diamondnode)

```bash
cd /root/ops-maintenance-agent

# One cycle: verify → PR inventory → Kimi push
node scripts/maintenance-cycle.mjs

# Kimi bridge (optional Moonshot key for LLM replies)
bash scripts/setup-kimi-bridge.sh
# bash scripts/setup-kimi-bridge.sh sk-YOUR_MOONSHOT_KEY

# Install scheduled cycle + HTTP control plane + post-boot/crash automation
bash scripts/install-automation.sh
# (or manual: cp systemd/*.service systemd/*.timer /etc/systemd/system/
#  systemctl daemon-reload && systemctl enable --now ops-maintenance-http …)
```

## Reboot / crash automation

| Unit | Role |
|------|------|
| `ops-post-boot.service` | On multi-user boot: crash analysis → heal allowlisted services → verify → Kimi |
| `ops-crash-analyze.service` + `.timer` | Read-only journal/failed-unit snapshot every 30m (`OnBootSec=5min`) |
| `ops-maintenance-cycle.timer` | 15m cycle; on critical/core-down runs analysis + force-heal if needed |
| `ops-maintenance-http.service` | Local control plane `127.0.0.1:8791` |

```bash
# Manual runs
node scripts/crash-analyze.mjs
node scripts/post-boot-reconfig.mjs [--force-heal]
node scripts/maintenance-cycle.mjs

# Status
systemctl status ops-post-boot.service
systemctl list-timers 'ops-*'
```

**Heal allowlist** (never `ssh`/`sshd`): openclaw-gateway, ollama, nginx, diamond-gateway, redis-server, qmem-llama-server, qmem-sync, genesis-ops-stream, cloudflared, ops-maintenance-http.

Reports: `reports/crash-analysis-latest.json`, `reports/post-boot-latest.json`, `reports/cycle-latest.json`.

## Unblock checklist

| Capability | Requirement |
|------------|-------------|
| PR babysit fix cycles | `gh auth login` or `GH_TOKEN` + git repo remote |
| Axiom monitors/dashboards | `~/.axiom.toml` with API token + org_id |
| Sentry live events | `SENTRY_DSN` (+ auth token for source maps) |
| Full Kimi LLM replies | Moonshot key → `setup-kimi-mobile-replies.sh` |
| CF Agent deploy | `wrangler login` + `npm i` + `npm run agent:deploy` |
| Vercel Workflow deploy | Link project, install `workflow`, wire API route with `start()` |

## HTTP API (local)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| GET | `/ops/verify` | Run verification, return JSON report |
| GET | `/ops/deployments` | Fleet deploy audit (Vercel/CF/local); `?refresh=1` to re-run |
| POST | `/ops/pr-babysit` | Inventory open PRs |
| POST | `/ops/kimi-update` | Push status to Kimi mobile |
| POST | `/ops/maintenance-cycle` | Full cycle |

Default: `http://127.0.0.1:8791`
