# Revenue Flywheel — Genesis / diamondnode

**North star:** 13 independent streams × **$70k MRR** floor = **$910k** combined.

## Loop (finalize)

```text
  ┌──────────────┐     discover      ┌─────────────────────┐
  │ Agent / A2A  │ ───────────────► │ /discovery + Shopify │
  │ marketplace  │                  │ catalog (preview)    │
  └──────▲───────┘                  └──────────┬──────────┘
         │                                     │ 402 challenge
         │ usage                               ▼
  ┌──────┴───────┐     USDC Base     ┌─────────────────────┐
  │ R01 meter    │ ◄── mint key ──── │ x402-monetize :8793 │
  │ :8792 public │                   │ settle + cashflow   │
  └──────┬───────┘                   └──────────┬──────────┘
         │                                      │
         │ metered $                            │ attribute
         ▼                                      ▼
  ┌──────────────┐                   ┌─────────────────────┐
  │ cashflow     │ ◄──────────────── │ Shopify orderCreate │
  │ ledger Redis │   record R01/R07  │ (when Admin token)  │
  └──────┬───────┘                   └─────────────────────┘
         │
         │ maintenance-cycle 15m
         ▼
  ┌──────────────┐
  │ Reinvest     │  GPU/q-mem (R02) · marketplace (R09) ·
  │              │  Aerodrome LP / Safe (R07) · coalition (R05)
  └──────────────┘
```

## Dual rails

| Rail | When | Surface |
|------|------|---------|
| **x402 (agents)** | Machine-to-machine USDC on Base | `ops-x402-monetize` → `http://127.0.0.1:8793` |
| **Stripe (humans)** | Card subscriptions | `https://inference.yennefer.quest` meter + webhook |
| **Shopify** | Human catalog + order books | `51wnq0-ip.myshopify.com` (preview → Save store) |

## Pay-to treasury

| Field | Value |
|-------|--------|
| Address | `0x9545e2439c5c75d3aA723AcaC1AA6B0fa1DB6956` |
| Role | HOT Account1 / Safe owner — receives agent USDC |
| Network | Base (`eip155:8453`) primary |

Override with env `X402_PAY_TO_ADDRESS` (never put private keys in unit files).

## Catalog (SKU → stream)

| Resource URN | SKU | USD | Stream |
|--------------|-----|-----|--------|
| `urn:genesis:agentic:skill:inference-credits` | AGENTIC-INFER-250 | 2.50 | R01 |
| `urn:genesis:agentic:inference:chat` | AGENTIC-INFER-CHAT | 0.05 | R01 |
| `urn:genesis:agentic:skill:listing-30d` | AGENTIC-SKILL-LIST-30 | 29 | R09 |
| `urn:genesis:agentic:license:coalition-seat` | AGENTIC-COALITION-SEAT | 70 | R05 |

## Commands

```bash
# Service
systemctl status ops-x402-monetize
curl -s http://127.0.0.1:8793/health | jq .
curl -s http://127.0.0.1:8793/flywheel | jq .
curl -i 'http://127.0.0.1:8793/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits'

# Flywheel snapshot + demo settle (local scaffold)
node scripts/revenue-flywheel.mjs status
node scripts/revenue-flywheel.mjs seed-demo

# Existing inference + cashflow
curl -s https://inference.yennefer.quest/pricing | jq .
curl -s http://127.0.0.1:8791/ops/cashflow | jq .totals
node scripts/cashflow-ledger.mjs
```

## Production hardening checklist

- [ ] `SHOPIFY_ADMIN_TOKEN` after **Save store** + app install → live order attribution
- [ ] Set `X402_FACILITATOR_SECRET` before any public tunnel to :8793
- [ ] Clear `X402_ALLOW_UNVERIFIED` and verify receipts via alloy/RPC
- [ ] `STRIPE_WEBHOOK_SECRET` + Payment Links for human MRR rail
- [ ] Optional Cloudflare tunnel hostname for monetize (agents only; keep admin local)
- [ ] Sweep payTo USDC → Safe / Aerodrome LP (R07) on a schedule

## Stream ownership (actuation)

| Stream | Agent | Flywheel role |
|--------|-------|---------------|
| R01 | genesis-twin | Paid inference (x402 packs + Stripe tiers) |
| R02 | yennefer | Capacity reinvest from R01 load |
| R05 | momus | Coalition seats via x402 |
| R07 | genesis-twin | Settlement mesh + treasury |
| R09 | momus | Skill listing fees |

## Files

| Path | Role |
|------|------|
| `scripts/x402-monetize-server.mjs` | Paid API + settle + mint |
| `scripts/revenue-flywheel.mjs` | Snapshot / seed-demo CLI |
| `shopify-agentic/` | Facilitator + Shopify attribution |
| `scripts/inference-meter.mjs` | Metered OpenAI-compatible API |
| `scripts/cashflow-ledger.mjs` | 13-stream MRR ledger |
| `systemd/ops-x402-monetize.service` | Durable unit |
| `reports/revenue-flywheel-latest.json` | Last snapshot |
