# Plan: R01 Public Inference + Stripe Cash Conversion

**Goal:** Convert the live metered inference API (R01) from local-only pipeline into a public, purchasable product that can book real MRR/cash into the cashflow ledger.

**North star:** 13 × $70k MRR. This plan targets R01 first-dollar path.

**Already done (do not redo):**
- `scripts/inference-meter.mjs` on `:8792` with API keys, tiers (starter $29 / pro $149 / enterprise $999), Redis usage
- nginx proxies `/v1/` → meter; unauth → 401
- q-mem on `:8082`; breath daemon paused for VRAM
- Cashflow ledger + Redis; pipeline already reflects product-live notes

**Workspace:** `/root/ops-maintenance-agent` on branch `feat/r01-public-stripe-checkout`

---

## Task 1: Public Cloudflare exposure for inference meter

**Files:**
- Create `systemd/cloudflared-inference.service` (or drop-in) using named tunnel config if certs exist, else documented quick-tunnel fallback
- Create `config/inference-public.json` with public base URL once known
- Update `STATUS.md` with public endpoints

**Spec:**
1. Expose `http://127.0.0.1:8792` publicly via Cloudflare Tunnel.
2. Prefer hostname `inference.genesisconductor.io` if tunnel credentials allow DNS route; otherwise use stable trycloudflare URL written to `reports/inference-public-url.txt` and `config/inference-public.json`.
3. Do **not** print tunnel tokens or secrets in logs/commits.
4. Verify externally (or via tunnel URL): `GET /health`, `GET /pricing`, `POST /v1/chat/completions` without key → 401.
5. systemd unit enabled if using a durable service file.

**Acceptance:**
- [ ] Public URL file written
- [ ] `/health` and `/pricing` reachable on public URL
- [ ] Unauthenticated chat returns 401
- [ ] No secrets committed

---

## Task 2: Stripe webhook fulfillment → mint keys + cashflow

**Files:**
- Extend `scripts/inference-meter.mjs`:
  - `POST /webhook/stripe` — verify signature when `STRIPE_WEBHOOK_SECRET` present; on `checkout.session.completed` mint tier key, store session→key mapping (Redis + disk), record cashflow via `cashflow-ledger.mjs` `recordCashflow('R01', { delta_mrr, delta_cash, note })`
  - `GET /issued-key?session_id=` — return key once (or 24h) for success page
  - `GET /pricing` — include checkout URL placeholders from env (`STRIPE_CHECKOUT_STARTER_URL`, etc.) without requiring live Stripe if unset
- Vault env keys expected (do not invent secret values): `STRIPE_WEBHOOK_SECRET`, optional checkout URLs
- Unit-style test script: `scripts/test-inference-meter.mjs` that simulates webhook with test secret OR dry-run mint path

**Spec:**
1. Map amounts/metadata to tiers: starter 2900, pro 14900, enterprise 99900 cents OR `metadata.tier`.
2. On successful checkout: mint key for that tier, label with customer email if present.
3. Call `recordCashflow('R01', { delta_mrr: price_mo, delta_cash: price_mo, note: 'stripe session …' })` so MRR/cash update.
4. If webhook secret missing: return 503 with clear message (do not accept unsigned webhooks in production mode). Allow `INFERENCE_WEBHOOK_DEV=1` only for local test HMAC with vaulted/dev secret.
5. Never log full API keys; only key id/prefix.

**Acceptance:**
- [ ] Webhook endpoint exists and rejects bad signatures
- [ ] Happy-path test mints key + updates cashflow (or documents blocked if no secret)
- [ ] `/issued-key` works for session id after fulfillment
- [ ] `/pricing` shows checkout links when env set

---

## Task 3: Ops cycle integration + STATUS + verify

**Files:**
- `scripts/verify.mjs` — boundary for inference-meter health + public URL file presence (optional non-critical)
- `scripts/maintenance-cycle.mjs` — include inference revenue + public URL in cycle summary
- `STATUS.md` — buyer playbook (public URL, Stripe webhook endpoint to configure in Dashboard)
- `reports/r01-go-live.json` — snapshot of readiness

**Spec:**
1. Verify reports inference meter active.
2. Cycle logs R01 estimated_mrr, active_keys, public URL.
3. STATUS documents how to configure Stripe webhook → `https://<public>/webhook/stripe`.
4. Run one full maintenance cycle; verification must not fail critically if public URL is only trycloudflare.

**Acceptance:**
- [ ] `node scripts/verify.mjs` shows inference meter healthy
- [ ] `reports/r01-go-live.json` written
- [ ] STATUS updated with go-live steps

---

## Task 4: Minimal automated tests for meter auth + webhook

**Files:**
- `scripts/test-inference-meter.mjs`
- Optional: `package.json` script `"test:inference": "node scripts/test-inference-meter.mjs"`

**Spec:**
1. Start against running meter (or spawn briefly).
2. Assert: health 200; chat without key 401; chat with vault starter key 200 or upstream model response.
3. Assert webhook rejects empty/invalid signature (401/400).
4. Exit non-zero on failure.

**Acceptance:**
- [ ] `npm run test:inference` (or node script) passes on diamondnode

---

## Out of scope
- Creating real Stripe products in Dashboard (needs human Stripe login) — code supports env checkout URLs
- Re-enabling breath daemon on GPU
- Disk offload
- Closing 247 PRs
