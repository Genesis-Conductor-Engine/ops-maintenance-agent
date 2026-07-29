# Diamondnode North Star MRR (Axiom)

**Audience:** Lead AI Systems Architect / founder  
**Refresh:** `team` (300s)  
**Time window:** 7d  
**Datasets:** `ops-maintenance` (primary), `ops-revenue` (optional cash ledger mirror)

## Decisions this board answers

| # | Decision | Panels that inform it |
|---|----------|------------------------|
| 1 | **Which stream to actuate next?** | `streams-at-floor`, `stream-mrr-table`, `r01-estimated-mrr` |
| 2 | **Is the cash path live?** | `go-live-blockers`, `blockers-evidence`, `r01-estimated-mrr`, `total-mrr` |
| 3 | **Is intrinsic loop healthy?** | `ptv-crystal` |
| 4 | **Can we trust ops actuation?** | `ops-cycle-health` |

## North-star numbers (local truth today)

Source of truth until Axiom ingest exists:

| Artifact | Path |
|----------|------|
| Goal scorecard | `reports/goal-scorecard-latest.json` |
| R01 go-live | `reports/r01-go-live.json` |
| Maintenance cycle | `reports/cycle-latest.json` |
| Procedural truth | `reports/procedural-truth-latest.json` |
| Cashflow | `reports/cashflow-latest.json` |

Targets: **13 streams × $70,000 MRR = $910,000** combined floor. R01 product: metered sovereign LLM API (`inference.yennefer.quest`).

## Panel blueprint

### At-a-Glance (Statistic)

| id | Question | Quantity | Unit |
|----|----------|----------|------|
| `total-mrr` | Are we on the cash path? | Latest `totals.total_mrr_usd` from `event == "goal_scorecard"` | USD |
| `streams-at-floor` | How many streams hit the floor? | Latest `totals.streams_at_floor` (0–13) | count |
| `r01-estimated-mrr` | Is R01 monetizing? | Latest `revenue.estimated_mrr` / `estimated_mrr` for `stream == "R01"` | USD |
| `ptv-crystal` | Is procedural truth PASS? | Latest `procedural_truth.crystal_value` (or `crystal_value`) | 0–1 |
| `go-live-blockers` | Is cash path unblocked? | Count of `go_live_blockers` on latest `event == "r01_go_live"` | count |
| `ops-cycle-health` | Is the ops loop healthy? | Share of cycles with `verification_ok == true` in window | % |

### Trends / Breakdowns

| id | Type | Question |
|----|------|----------|
| `mrr-trend` | TimeSeries | Is total MRR climbing toward $910k? |
| `stream-mrr-table` | Table | Per-stream MRR (R01–R13) — pick next actuation |
| `blockers-evidence` | Table / LogStream | Exact go-live blocker strings to clear |

### Context

| id | Type | Purpose |
|----|------|---------|
| `intro` | Note | Scope, decisions, local report pointers |

## Intended ingest schema (not yet on Axiom)

Emit one event per maintenance cycle / scorecard run into `ops-maintenance` (flatten nested JSON):

```json
{
  "event": "goal_scorecard",
  "host": "diamondnode",
  "total_mrr_usd": 1442,
  "streams_at_floor": 0,
  "streams_total": 13,
  "pct_to_combined_floor": 0.158,
  "stream_R01_mrr": 1442,
  "stream_R02_mrr": 0,
  "crystal_value": 0.93,
  "ptv_ok": true,
  "r01_estimated_mrr": 1442,
  "go_live_blockers_count": 2,
  "go_live_blockers": ["…", "…"],
  "verification_ok": true,
  "cycle_ok": true
}
```

Optional parallel events:

- `event == "r01_go_live"` — readiness flags + blockers array  
- `event == "ops_cycle"` — cycle health / duration_ms  
- `ops-revenue` dataset — cash ledger deltas (`stream`, `delta_mrr`, `delta_cash`)

## Deploy status

| Item | State |
|------|-------|
| Blueprint | this file |
| APL catalog | `dashboard-spec/north-star-mrr.apl.json` |
| Assembled deferred dashboard | `dashboard-spec/north-star-mrr.dashboard.json` (Note panels — Compute or Defer) |
| Deploy script | `scripts/deploy-north-star-dashboard.mjs` |
| Live Axiom deploy | **BLOCKED** — `AXIOM_TOKEN` / `AXIOM_ORG_ID` missing in vault; `~/.axiom.toml` still has placeholders |

### Unblock deploy

```bash
echo -n 'xaat-…' | vault-set AXIOM_TOKEN
echo -n 'your-org-id' | vault-set AXIOM_ORG_ID
vault-apply-axiom
# create datasets ops-maintenance (+ ops-revenue) in Axiom UI/API
# wire cycle/scorecard ingest → then:
node scripts/deploy-north-star-dashboard.mjs
# after getschema validates intended fields:
node scripts/deploy-north-star-dashboard.mjs --promote-apl
```

## Relation to ops-overview

`dashboard-spec/ops-overview.md` remains the **oncall** ops health board (errors, cycle latency, PRs). This north-star board is **exec / founder** cash + truth goals — complementary, not a replacement.

## Skill compliance

- **Decisions first** — every panel maps to actuate-next or cash-path-live.  
- **Compute or Defer** — until schema is discovered via `getschema` on live data, KPI charts ship as **Note** panels documenting blockers (see assembled dashboard). Intended APL lives in `north-star-mrr.apl.json` and must not be substituted with a different quantity.  
- **Rates/percentiles** — cycle health uses success rate, not average duration alone.  
- **Validate with data** — promote APL only after ingest + `getschema`.
