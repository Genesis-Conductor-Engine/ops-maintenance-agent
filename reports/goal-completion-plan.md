# Kovach Enterprises — Goal Completion Plan
**Role:** Lead AI Systems Architect · **Date:** 2026-07-29  
**North star:** 13 × $70k = **$910k MRR** · **Now:** $1,442 (0.158%) · **streams_at_floor:** 0/13  
**Authoritative scorecard:** R01 only has estimated MRR; cash blocked by Stripe vault + Payment Links. AI loopbacks **healthy** (PTV crystal ~0.93, q-mem/ollama/tunnel OK).

| Goal | Status | Strategy |
|------|--------|----------|
| (1) Financial infra 13×$70k | **P0 red** | Single-thread R01 cash close → R02 second stream → portfolio parallel |
| (2) Procedural / invariant truth | **green** | Keep PTV timer; no thrash during revenue activation |
| (3) Human–AI hybridization | **P1 ready** | OpenClaw/Kimi + diamondnode when PTV ok (now ok) |
| (4) Personal / ops balance | **protect** | Human owns Stripe/Shopify secrets; agents own code, probes, scorecard |

---

## Immediate (today)

1. **Finish branch `feat/r01-public-stripe-checkout`** (ops-maintenance-agent)  
   - **Ship as-is for code path:** public edge + meter + webhook fail-closed + `/pricing` env URLs + `r01-go-live` / cycle integration are the product; remaining work is **ops secrets**, not more feature branches.  
   - **Do before merge:** (a) `npm run test:inference` (or `node scripts/test-inference-meter.mjs`) green on diamondnode; (b) confirm go-live blockers only list vault/Payment Links (not code regressions); (c) STATUS.md buyer playbook matches live URL `https://inference.yennefer.quest`; (d) no secrets in git.  
   - **Merge recommendation:** merge to main **after** webhook secret is installed and one signed `checkout.session.completed` (test mode OK) mints a key + books R01 cashflow — or merge with documented “code complete / go-live blocked on vault” if you need deploy freeze elsewhere. Prefer **merge once cash path proven once**.  
   - **Out of branch scope (human Dashboard):** Stripe products + Payment Links; do not invent secret values in PR.

2. **P0 cash unblock (single thread — revenue agent order)**  
   - Install `STRIPE_WEBHOOK_SECRET` in vault; Dashboard webhook → `https://inference.yennefer.quest/webhook/stripe` (`checkout.session.completed`); restart meter unit.  
   - Create Stripe products/links (starter/pro/enterprise); set `STRIPE_CHECKOUT_*` so `/pricing` shows CTAs.  
   - One non-test (or signed test) session → key issue → **cashflow `R01 mrr_actual > 0`** (close meter $1442 vs ledger $0 gap).  

3. **Do not divert:** public `/admin` 404 is by design; AI stack needs no core fix today. Optional later: `yennefer_public_api` timeout + `ztm-rpsi-port-forward` if tunnel-check ledger must be green.

4. **Hybridization / truth:** leave `ops-procedural-truth-loop.timer` alone; log one PTV pass as baseline before revenue fire drill.

---

## This week

| Priority | Action | Owner / stream |
|----------|--------|----------------|
| P0 | Convert $30k pipeline + grow 8 keys → real Stripe MRR toward R01 $70k floor (usage + paid tiers) | genesis-twin / R01 |
| P0 | Fix acquisition funnel: `vercel:genesis-conductor-site`, probes on genesisconductor.io / optimizationinversion.com → checkout | deploy / marketing |
| P0 | Stand up **R02** cash path (GPU/q-mem) so scorecard shows non-zero MRR beyond R01 | yennefer / R02 |
| P0 | Enable **x402 / payment-engine** settlement for coalition seats (R05) | momus / R05 |
| P1 | Shopify Admin token; leave dry-run attribution → live settle (partner/DRP evidence) | monetize / R01||R07 |
| P1 | Re-run goal-scorecard after Stripe go-live + first multi-stream cash events | infra |
| P1 | Keep hybridization loopbacks healthy while revenue runs (OpenClaw/Kimi + diamondnode) | partner |

**Week success criteria:** R01 `mrr_actual` recognized; ≥1 second stream `> 0`; go-live blockers empty; scorecard `pct_to_combined_floor` measurably up from 0.158%.

---

## This month

1. **Portfolio activation (parallel after R01 closed-loop)**  
   - **R03** MCP/product workers (gc-mcp) → billable readiness  
   - **R07** on-chain settlement + Shopify agentic attribution for Soul/x402 cash  
   - **R09** paid skills / marketplace fees  
   - Queue R04, R06, R08, R10–R13 with stream modules; no stream idles at $0 without a named cash experiment  

2. **Scale R01 to floor path:** tier mix + volume from ~$1.4k estimated → path to $70k (enterprise seats, partner funds/DRP narrative only after real card MRR).  

3. **Goals 2–4 (protect capacity)**  
   - Procedural truth: PTV crystal ≥ ~0.93; fail closed on truth regressions  
   - Hybridization: human owns capital/secrets; agents own actuation/scorecard/meter  
   - Ops balance: P0 revenue only on critical path; infra “healthy” is maintain, not expand; personal time = secrets Dashboard + partner/DRP, not meter code churn  

4. **Monthly gate:** streams_at_floor ≥ 1 preferred; total_mrr trending; re-scorecard weekly; no second large branch on R01 unless cash path breaks.

---

## Decision summary

| Item | Call |
|------|------|
| Critical path | Vault webhook → Payment Links → first paid session → ledger R01 > 0 |
| Branch | **Finish & prove cash once on `feat/r01-public-stripe-checkout`, then merge**; Dashboard products are human, not more code |
| Second stream | R02 cash this week; R05 x402 in parallel once R01 unblocked |
| Infra | Healthy — do not prioritize stack rebuild over Stripe |
| Hybrid / truth | Maintain PTV + diamondnode; activate deeper hybrid after cash loop closes |

**Next single action:** set `STRIPE_WEBHOOK_SECRET` + Dashboard webhook, then Payment Links, then one paid session.