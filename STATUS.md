# Ops Maintenance Status — 2026-07-21 (R01 + x402 monetize + flywheel)

## North star
**Cashflow accumulation**: 13 streams × **$70,000** MRR floor = **$910,000** combined.

## Live product surfaces (2026-07-21)

| Stream | Product | Endpoint | Pricing |
|--------|---------|----------|---------|
| **R01** | Metered Sovereign LLM API | **https://inference.yennefer.quest** (+ local `:8792` / nginx `/v1/`) | starter **$29**/mo · pro **$149** · enterprise **$999** |
| **R01/R05/R09** | **x402 agent pay** | local `:8793` (`ops-x402-monetize`) | inference pack **$2.50** · skill list **$29** · coalition seat **$70** |
| **R02** | q-mem GPU backend | `:8082` (proxied via meter) | bundled with R01 tiers |
| **R07** | On-chain mesh + treasury | alloy probe Base/OP/Polygon/ETH · payTo `0x9545…6956` | settlement ready |
| **R11/R12** | Telemetry API (Stripe) | https://api.genesisconductor.io | pro **$49** · enterprise **$499** |

### Revenue flywheel (finalized)

Doc: `docs/REVENUE_FLYWHEEL.md` · snapshot: `reports/revenue-flywheel-latest.json` · go-live: `reports/monetize-go-live.json`

```text
Agent discover → 402 challenge → USDC (Base) → settle → cashflow (+ Shopify dry-run) → mint API key → meter usage → reinvest
```

```bash
systemctl status ops-x402-monetize
curl -s http://127.0.0.1:8793/health | jq .
curl -s http://127.0.0.1:8793/flywheel | jq .
curl -i 'http://127.0.0.1:8793/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits'
npm run flywheel
# scaffold settle (local only; ALLOW_UNVERIFIED=1 in unit):
npm run flywheel:seed
```

**payTo (Base USDC):** `0x9545e2439c5c75d3aA723AcaC1AA6B0fa1DB6956`

**Blockers before public agent expose:** Save Shopify store + Admin token; set `X402_FACILITATOR_SECRET`; clear `X402_ALLOW_UNVERIFIED` + RPC-verify receipts; optional Stripe Payment Links for human rail.

### Inference meter (R01) — public

| Item | Value |
|------|--------|
| Public base URL | `https://inference.yennefer.quest` |
| Preferred future hostname | `inference.genesisconductor.io` (needs CF zone CNAME → same tunnel) |
| Config | `config/inference-public.json` · `reports/inference-public-url.txt` |
| Tunnel unit | `cloudflared-inference.service` (named tunnel `inference-meter`) |
| Tunnel config | `config/cloudflared-inference.yml` (credentials **outside** repo) |
| Local origin | `http://127.0.0.1:8792` (`ops-inference-meter.service`) |
| Stripe webhook | `https://inference.yennefer.quest/webhook/stripe` |
| Quick-tunnel fallback | `systemd/cloudflared-inference-quick.service.example` |
| Readiness snapshot | `reports/r01-go-live.json` (written every maintenance cycle) |

Public probes (no secrets):

```bash
curl -sS https://inference.yennefer.quest/health
curl -sS https://inference.yennefer.quest/pricing
# expect 401:
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://inference.yennefer.quest/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"phi-2","messages":[{"role":"user","content":"hi"}]}'
```

Local / nginx:

```bash
# Pricing
curl -s http://127.0.0.1/pricing | jq .

# Chat (requires vaulted key)
export KEY=$(cat /root/.vault/secrets/INFERENCE_KEY_STARTER)
curl -s http://127.0.0.1/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"phi-2.Q4_K_M.gguf","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'

# Mint customer key (admin — localhost only)
export ADMIN=$(cat /root/.vault/secrets/INFERENCE_ADMIN_TOKEN)
curl -s -X POST http://127.0.0.1:8792/admin/keys \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"tier":"starter","label":"customer-1"}'

# Revenue snapshot (localhost only; public /admin → 404)
curl -s http://127.0.0.1:8792/admin/revenue -H "Authorization: Bearer $ADMIN"
```

Service: `ops-inference-meter.service` · public edge: `cloudflared-inference.service` · keys in `/root/.vault/secrets/INFERENCE_*`

**GPU policy**: `yennefer-breath-daemon` disabled so GTX 1650 VRAM serves paid inference. See `reports/gpu-priority-r01.json`.

---

## R01 buyer playbook / Stripe go-live

Use this when converting the first paying customer. Public URL always comes from `config/inference-public.json` (fallback: `reports/inference-public-url.txt`).

### 1. Confirm public product is live

```bash
PUBLIC=$(jq -r .public_base_url /root/ops-maintenance-agent/config/inference-public.json)
# currently: https://inference.yennefer.quest
curl -sS "$PUBLIC/health" | jq .
curl -sS "$PUBLIC/pricing" | jq '{checkout_ready,webhook,pricing:.pricing|keys}'
node /root/ops-maintenance-agent/scripts/verify.mjs   # "Inference meter (R01)" must be ✅
# Public URL boundary is optional/non-critical (trycloudflare OK for staging)
```

### 2. Configure Stripe webhook (Dashboard)

1. Open **Stripe Dashboard → Developers → Webhooks → Add endpoint**.
2. **Endpoint URL** (production):

   ```
   https://inference.yennefer.quest/webhook/stripe
   ```

   If the public base URL changes, re-read config:

   ```bash
   jq -r '"\(.public_base_url)/webhook/stripe"' /root/ops-maintenance-agent/config/inference-public.json
   ```

3. **Events to send**: at minimum `checkout.session.completed` (fulfillment mints API key + books R01 cashflow).
4. After creating the endpoint, copy the **Signing secret** (`whsec_…`).
5. Install secret on diamondnode (never commit):

   ```bash
   # preferred vault secret file
   install -m 600 /dev/stdin /root/.vault/secrets/STRIPE_WEBHOOK_SECRET <<<'whsec_…'
   # and/or agent.env consumed by ops-inference-meter.service
   echo 'STRIPE_WEBHOOK_SECRET=whsec_…' >> /root/.vault/env/agent.env
   systemctl restart ops-inference-meter.service
   ```

6. Without `STRIPE_WEBHOOK_SECRET`, `POST /webhook/stripe` returns **503** (fail-closed; unsigned webhooks rejected).
7. Confirm readiness flag:

   ```bash
   jq '{readiness,endpoints,go_live_blockers}' /root/ops-maintenance-agent/reports/r01-go-live.json
   # stripe_webhook_secret: true when vault has the secret
   ```

### 3. Stripe Payment Links / Checkout URLs (optional until products exist)

Set Payment Link URLs so `GET /pricing` exposes buyer CTAs:

| Env (vault / agent.env) | Tier |
|-------------------------|------|
| `STRIPE_CHECKOUT_STARTER_URL` | starter **$29**/mo |
| `STRIPE_CHECKOUT_PRO_URL` | pro **$149**/mo |
| `STRIPE_CHECKOUT_ENTERPRISE_URL` | enterprise **$999**/mo |

Restart `ops-inference-meter` after setting. Amounts map automatically: 2900 / 14900 / 99900 cents → tier when `metadata.tier` is absent.

### 4. Buyer success path

1. Customer pays via Payment Link / Checkout.
2. Stripe sends `checkout.session.completed` → `POST …/webhook/stripe`.
3. Meter mints tier key, stores session mapping, records R01 cashflow (`delta_mrr` + `delta_cash`).
4. Success page redeems once (24h):

   ```bash
   curl -sS "https://inference.yennefer.quest/issued-key?session_id=cs_…"
   ```

5. Customer calls the API:

   ```bash
   curl -sS https://inference.yennefer.quest/v1/chat/completions \
     -H "Authorization: Bearer sk_live_…" \
     -H 'content-type: application/json' \
     -d '{"model":"phi-2","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
   ```

### 5. Ops cycle visibility

Every `ops-maintenance-cycle` run logs R01 **estimated_mrr**, **active_keys**, and **public_url**, and refreshes `reports/r01-go-live.json` + `reports/cycle-latest.json` (field `inference`).

```bash
node scripts/maintenance-cycle.mjs
jq '.inference' reports/cycle-latest.json
jq . reports/r01-go-live.json
```

**Admin revenue remains localhost-only** (`:8792/admin/*`); do not expose admin tokens on the public tunnel.

## Observability (Axiom skipped)

| Stack | Role |
|-------|------|
| Redis | cashflow ledger + inference usage + keys |
| genesis-ops-stream **:8787** | live ops SSE (already running) |
| ops-maintenance-http **:8791** | verify / cashflow / cycle API |
| ops-inference-meter **:8792** | metered OpenAI-compatible API (public via `cloudflared-inference` → https://inference.yennefer.quest) |
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
