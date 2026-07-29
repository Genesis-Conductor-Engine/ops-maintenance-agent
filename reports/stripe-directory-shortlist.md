# Stripe Directory shortlist — diamondnode R01 revenue activation

**Buyer:** Kovach Enterprises / diamondnode  
**Generated:** 2026-07-29T05:29:19.236853+00:00  
**Shortlist size:** 10 (max 10)  
**Queries run:** 14  
**Raw hits (sum across queries, pre-dedupe):** 87  

## Goals

- Partner funding / cloud credits / Partner Services Funds for AI startups
- Stripe billing / Payment Links / usage-based metering for LLM API SaaS
- Optional MPP-supported services for agent-paid workflows

## Honesty check

- **Billing / metering / Payment Links:** strong Directory density (OpenMeter, Klaim, Schematic, Orb cluster).
- **MPP agent-paid services:** good after broadening to `API --mpp-supported` (Parallel, Browserbase, You.com, Zinc).
- **Partner funding / PSF / cloud credits:** **sparse**. Directory returns incubators, cloud consultants, and GPU hosts — not AWS Activate / Azure credits / Google for Startups / classic Partner Services Funds. Pursue those outside Stripe Directory.
- **Purchases:** none. Discovery only.

## Shortlist

### Direct

#### OpenMeter

- **Why matched:** Usage metering and billing for B2B SaaS — direct fit for LLM API SaaS usage-based metering and Stripe-aligned revenue activation.
- **URL:** https://stri.pe/sl/wq6CbW6b
- **Profile:** https://stri.pe/sl/gzp2dHo3
- **Query used:** `usage-based metering LLM API SaaS`
- **Also surfaced by:** `AI API billing metering`, `subscription billing SaaS metering`

#### Klaim

- **Why matched:** Explicitly positioned as usage-based billing for AI startups — strongest wording match for diamondnode-style LLM API metering.
- **URL:** https://stri.pe/sl/H8KwyyQV
- **Profile:** https://stri.pe/sl/UEfThjLg
- **Query used:** `AI API billing metering`
- **Also surfaced by:** `usage-based metering LLM API SaaS`, `subscription billing SaaS metering`

#### Schematic

- **Why matched:** Feature packaging / entitlements lifecycle for SaaS; Stripe Projects provider (catalog/install). Useful next to metering for plan gates and packaging of LLM features.
- **URL:** https://stri.pe/sl/DVFfp0Nk
- **Profile:** https://stri.pe/sl/bjURFhRd
- **Query used:** `usage-based metering LLM API SaaS`
- **Also surfaced by:** `feature flags entitlements packaging SaaS`, `subscription billing SaaS metering`, `billing --stripe-projects-supported`
- **Trust signals:** Projects provider
- **Projects:** `stripe projects catalog schematic` · `stripe projects add schematic`

#### Parallel

- **Why matched:** MPP-supported agent web search/research APIs — purchasable via Machine Payment Protocol for agent-paid workflows. Also Stripe App + Projects provider.
- **URL:** https://stri.pe/sl/xZ4GaIwy
- **Profile:** https://stri.pe/sl/Y1Hj3k6P
- **Query used:** `API --mpp-supported`
- **Also surfaced by:** `data --mpp-supported`
- **Trust signals:** Projects provider, MPP (`parallel`), Stripe App
- **Projects:** `stripe projects catalog parallel_web_systems` · `stripe projects add parallel_web_systems`
- **MPP endpoints:** https://mpp.dev/services#parallel, https://docs.parallel.ai/integrations/agentic-payments

#### Browserbase

- **Why matched:** MPP-supported headless browser / fetch / search primitives for production agents — strong agent-paid workflow fit.
- **URL:** https://stri.pe/sl/fKDaWG05
- **Profile:** https://stri.pe/sl/zmQKIEiM
- **Query used:** `API --mpp-supported`
- **Also surfaced by:** `data --mpp-supported`
- **Trust signals:** Projects provider, MPP (`browserbase`), Stripe App
- **Projects:** `stripe projects catalog browserbase` · `stripe projects add browserbase`
- **MPP endpoints:** https://mpp.dev/services#browserbase, https://mpp.browserbase.com/

### Adjacent

#### You.com

- **Why matched:** MPP-supported real-time web search/extract/data APIs for AI apps — adjacent agent tooling rather than billing stack.
- **URL:** https://stri.pe/sl/378wKYgO
- **Profile:** https://stri.pe/sl/KNRk59fL
- **Query used:** `API --mpp-supported`
- **Also surfaced by:** `data --mpp-supported`
- **Trust signals:** MPP (`see endpoints`)
- **MPP endpoints:** https://you.com/docs/llms.txt, https://you.com/docs/api-reference/search/v1-search-post

#### PayWhirl

- **Why matched:** Recurring billing, subscriptions, payment plans — adjacent to Payment Links / subscription checkout for SaaS GTM, less focused on usage metering.
- **URL:** https://stri.pe/sl/xoPyvmCO
- **Profile:** https://stri.pe/sl/KtdZeo60
- **Query used:** `subscription billing SaaS metering`
- **Also surfaced by:** `Stripe billing Payment Links subscription SaaS`

#### Runpod

- **Why matched:** GPU/AI compute platform for building and running AI systems — adjacent to cloud-credits style cost reduction (not a Partner Services Fund admin, but relevant infra spend partner).
- **URL:** https://stri.pe/sl/q3HVUAlj
- **Profile:** https://stri.pe/sl/3tzrbxeT
- **Query used:** `GPU cloud compute`

#### DigitalOcean

- **Why matched:** Hyperscaler-adjacent cloud provider known for startup credits programs; surfaced under GPU/cloud compute. Directory profile thin (no description) — treat as brand match for cloud credits pathway, not PSF.
- **URL:** https://stri.pe/sl/dVkmIDhz
- **Profile:** https://stri.pe/sl/YEqRIgPz
- **Query used:** `GPU cloud compute`

### Needs manual review

#### Orb, Inc.

- **Why matched:** Repeatedly ranked in usage-metering / AI billing queries (OpenMeter-adjacent cluster). Description and site URL empty in Directory — strong industry brand for usage billing but needs manual verification of profile completeness.
- **URL:** https://stri.pe/sl/rNz1SKMk
- **Query used:** `usage-based metering LLM API SaaS`
- **Also surfaced by:** `AI API billing metering`, `subscription billing SaaS metering`

## Queries run

| # | Query | Filters | Results | Note |
|---|-------|---------|---------|------|
| 1 | `partner funding AI startup cloud credits` | — | 4 | Sparse; no true Partner Services Fund admins. GPU/LLM adjacents only. |
| 2 | `partner services fund AWS Azure GCP startup` | — | 7 | Mostly cloud consultants/IT services, not PSF/credits programs. |
| 3 | `usage-based metering LLM API SaaS` | — | 4 | Strong: Schematic, OpenMeter, Orb, Klaim. |
| 4 | `Stripe billing Payment Links subscription SaaS` | — | 10 | Checkout/subscription tools; mixed quality. |
| 5 | `AI API billing metering` | — | 10 | Strong metering + LLM gateway cluster. |
| 6 | `agent payment API` | mpp_supported=True | 0 | Too narrow; empty. |
| 7 | `API` | mpp_supported=True, limit=10 | 4 | Parallel, Browserbase, Zinc, You.com. |
| 8 | `data` | mpp_supported=True, limit=10 | 3 | Browserbase, Parallel, You.com. |
| 9 | `subscription billing SaaS metering` | — | 9 | Confirms billing cluster + PayWhirl/PriceWell. |
| 10 | `feature flags entitlements packaging SaaS` | — | 1 | Schematic only. |
| 11 | `startup accelerator cloud credits funding` | — | 5 | Weak incubator/consulting noise; no hyperscaler PSF. |
| 12 | `payment links checkout subscription` | — | 10 | Checkout/payment-link adjacent vendors. |
| 13 | `billing` | stripe_projects_supported=True, limit=10 | 10 | Projects providers including Schematic, Clerk, etc. |
| 14 | `GPU cloud compute` | — | 10 | Runpod, DigitalOcean, io.net, CoreWeave-ish profiles. |

## Blockers / setup

- **[resolved]** (info) stripe CLI was missing at start; installed v1.44.0 from GitHub release + `stripe plugin install directory` (auto).
  - `curl -sL https://github.com/stripe/stripe-cli/releases/download/v1.44.0/stripe_1.44.0_linux_x86_64.tar.gz | tar -xz -C /usr/local/bin stripe`
  - `stripe plugin install directory`
- **[open]** (info) Not authenticated to a Stripe account (`stripe whoami` → Authenticated: false). Directory search still returned public results without login.
  - `stripe login`
  - _Login needed for Projects catalog/install and any purchase/MPP spend flows. Discovery only — no purchases made._
- **[open]** (coverage) True Partner Services Funds / hyperscaler AI startup cloud-credit programs are poorly represented (or absent) in Stripe Directory. Treat partner-funding goal as mostly outside this catalog; use AWS/GCP/Azure/Stripe Atlas partner portals separately.
- **[resolved]** (empty_filter) Query `agent payment API --mpp-supported` returned []. Broader `API --mpp-supported` worked.
  - `stripe directory search "API" --format json --mpp-supported --limit=10`

## Auth (if you need Projects / purchase later)

```bash
stripe login
stripe whoami
# optional Projects plugin:
stripe plugin install projects
```

Directory search itself worked **without** login in this environment.

## Exact CLI examples used

```bash
stripe directory search "usage-based metering LLM API SaaS" --format json --limit 10
stripe directory search "AI API billing metering" --format json --limit 10
stripe directory search "API" --format json --limit=10 --mpp-supported
stripe directory search "GPU cloud compute" --format json --limit 10
```
