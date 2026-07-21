# Ops Maintenance Status — 2026-07-21 (cashflow actuation)

## North star
**Cashflow accumulation**: 13 streams × **$70,000** MRR floor = **$910,000** combined.

## Live product surfaces (2026-07-21)

| Stream | Product | Endpoint | Pricing |
|--------|---------|----------|---------|
| **R01** | Metered Sovereign LLM API | `http://127.0.0.1:8792` + nginx `/v1/` | starter **$29**/mo · pro **$149** · enterprise **$999** |
| **R02** | q-mem GPU backend | `:8082` (proxied via meter) | bundled with R01 tiers |
| **R07** | On-chain mesh | alloy probe Base/OP/Polygon/ETH | settlement ready |
| **R11/R12** | Telemetry API (Stripe) | https://api.genesisconductor.io | pro **$49** · enterprise **$499** |

### Inference meter (R01)

```bash
# Pricing
curl -s http://127.0.0.1/pricing | jq .

# Chat (requires vaulted key)
export KEY=$(cat /root/.vault/secrets/INFERENCE_KEY_STARTER)
curl -s http://127.0.0.1/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"phi-2.Q4_K_M.gguf","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'

# Mint customer key (admin)
export ADMIN=$(cat /root/.vault/secrets/INFERENCE_ADMIN_TOKEN)
curl -s -X POST http://127.0.0.1:8792/admin/keys \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"tier":"starter","label":"customer-1"}'

# Revenue snapshot
curl -s http://127.0.0.1:8792/admin/revenue -H "Authorization: Bearer $ADMIN"
```

Service: `ops-inference-meter.service` · keys in `/root/.vault/secrets/INFERENCE_*`

**GPU policy**: `yennefer-breath-daemon` disabled so GTX 1650 VRAM serves paid inference. See `reports/gpu-priority-r01.json`.

## Observability (Axiom skipped)

| Stack | Role |
|-------|------|
| Redis | cashflow ledger + inference usage + keys |
| genesis-ops-stream **:8787** | live ops SSE (already running) |
| ops-maintenance-http **:8791** | verify / cashflow / cycle API |
| ops-inference-meter **:8792** | metered OpenAI-compatible API |
| Kimi notify-owner | mobile cycle + cashflow alerts |
| `reports/*.json` | durable local evidence |
| Alloy chain mesh | `scripts/chain-mesh-status.mjs` → `reports/chain-mesh-latest.json` |

## Cashflow API / CLI

```bash
# Snapshot
curl -s http://127.0.0.1:8791/ops/cashflow | jq .totals

# Record revenue motion
node scripts/cashflow-ledger.mjs record R01 --mrr 5000 --cash 1200 --note "first customer"
# or:
curl -s -X POST http://127.0.0.1:8791/ops/cashflow/record \
  -H 'content-type: application/json' \
  -d '{"stream":"R01","mrr_actual":5000,"cash_collected_mtd":1200,"note":"invoice paid"}'
```

## Automation (live)
| Component | Status |
|-----------|--------|
| ops-post-boot.service | enabled (oneshot after boot) |
| ops-crash-analyze.timer | 30m |
| ops-maintenance-cycle.timer | 15m (includes cashflow + Kimi + PR inventory) |
| openclaw-gateway + Kimi | active |
| agentic-arbitration (Alloy) | local crate `/root/agentic-arbitration` |

## PR babysit (unblocked 2026-07-10)

Defaults when not inside a git remote:

| Env | Effect |
|-----|--------|
| `GH_OWNER` / `GH_ORG` | Org-wide open PR search (default **Genesis-Conductor-Engine**) |
| `GH_REPO` | Single `owner/name` |
| `GH_REPOS` | Comma-separated list |

Wired via:
- `/etc/systemd/system/ops-maintenance-cycle.service.d/gh-owner.conf`
- `/root/.vault/env/agent.env` (`GH_OWNER`, `GH_TOKEN`)

## Deployments & CI/CD (2026-07-10 — R10)

| Surface | Count | Status |
|---------|------:|--------|
| Local production services | 11/11 | active |
| Cloudflare Workers (on disk) | 23/23 | present |
| Vercel projects (2 teams) | 11 | registry + audit |
| Vercel CLI | 48.12.1 | installed globally |
| Public probes | 5/6 | `optimizationinversion.com` fail |

**Control plane**
- Registry: `config/deploy-registry.json`
- Audit: `node scripts/deployments-audit.mjs` → `reports/deployments-latest.json`
- HTTP: `GET /ops/deployments` (refresh with `?refresh=1`)
- GHA template: `.github/workflows/vercel-deploy.yml` (prebuilt pull→build→deploy)
- Docs: `docs/deployments-cicd-diamondnode.md`
- Cycle includes deploy brief in Kimi updates

**P0 Vercel**
- `genesis-conductor-site`: **FIXED** — PR #13 merged; production deploy `dpl_7f3k3icveZdLNCu3EmsRbfkaSqND` **READY** (Next 15.5 + pinned OpenNext). Aliases: `genesisconductor.io`, `www.genesisconductor.io`.
- CF Workers GHA still fails fast (likely missing `CLOUDFLARE_API_TOKEN` secrets) — separate from Vercel path.
- Live Vercel API in local audit needs `VERCEL_TOKEN` in vault (`agent.env`).

**Teams**
- Genesis Conductor `team_6rZHKfzSFyuOCZVa6EQQGSjo`
- Instinct `team_5piZ5dwpvq275dgTrPOcv5B7`

## Remaining focus (cashflow first)
- Convert pipeline ($28k) → real MRR / cash on R01, R02, R07
- Merge genesis-conductor-site Vercel install fix → confirm READY production
- Set `VERCEL_TOKEN` for live deploy audit / CLI promote-rollback
- Triage actionable open PRs (many historical CI failures on genesis-seismic-log / arbiter / Yennefer)
- `/home` disk **~95%** — schedule offload (`/data/diamondnode-recovery/scripts/disk_offload.sh`)
- Optional: Sentry DSN (not required)
