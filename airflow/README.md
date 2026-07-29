# Airflow DAGs — diamondnode ops (goal scorecard + R01 reconcile)

Scaffolding for **Airflow 3.3+** (AIP-103 `task_state_store` / `asset_state_store`) around revenue and goal scorecard cycles.

| DAG | File | Schedule | Purpose |
|-----|------|----------|---------|
| `ops_goal_scorecard` | `dags/ops_goal_scorecard_dag.py` | `@hourly` | Run `goal-scorecard.mjs` (+ `procedural-truth.mjs` if present); checkpoint cursors / metrics; asset watermark |
| `ops_r01_stripe_reconcile` | `dags/ops_r01_stripe_reconcile_dag.py` | `@hourly` | Reconcile `r01-go-live.json` vs `goal-scorecard-latest.json`; checkpoint `last_reconcile_at` |

## Requirements

- **Apache Airflow ≥ 3.3** (task/asset state stores are not available before 3.3)
- Node.js on the worker (for `scripts/*.mjs`)
- Repo checkout at `/root/ops-maintenance-agent` (or set `OPS_MAINTENANCE_ROOT`)

### Version check

```bash
af config version
# or
airflow version
```

If the version is **below 3.3**, do not enable these DAGs for state-store behaviour — install/upgrade Airflow first. These files are still valid 3.3 SDK DAGs for packaging and review offline.

## Install (high level)

1. Install Airflow 3.3+ into your environment (official docs: [Apache Airflow](https://airflow.apache.org/docs/)).
2. Point `AIRFLOW_HOME` and the DAG bag at this folder, e.g.:

   ```bash
   export AIRFLOW_HOME=/opt/airflow
   # In airflow.cfg or env:
   # dags_folder = /root/ops-maintenance-agent/airflow/dags
   ```

3. Ensure workers can execute:

   ```bash
   node /root/ops-maintenance-agent/scripts/goal-scorecard.mjs
   node /root/ops-maintenance-agent/scripts/procedural-truth.mjs   # optional
   ```

4. Restart scheduler / DAG processor and confirm DAGs appear:

   ```bash
   af dags list   # or: airflow dags list
   ```

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPS_MAINTENANCE_ROOT` | `/root/ops-maintenance-agent` | Repo root for scripts + reports |
| `PTV_SCRIPT` | (set in scripts) | Path to procedural truth verifier (used by Node scripts, not the DAG directly) |
| `PTV_SOURCE` | `ops-loop` | Source label for procedural-truth.mjs |

Reports written/read under `$OPS_MAINTENANCE_ROOT/reports/`:

- `goal-scorecard-latest.json`
- `procedural-truth-latest.json` (if PTV step runs)
- `r01-go-live.json` (input; produced by maintenance cycle)
- `r01-stripe-reconcile-latest.json` (reconcile output)

## State stores (AIP-103)

### `task_state_store` (per task instance, survives retries)

**Goal scorecard**

- `last_cursor` — monotonic progress counter within the TI
- `last_evt_id` — last procedural-truth / scorecard event id
- `crystal_value` — latest crystal score
- `total_mrr_usd` — latest combined MRR from scorecard

**R01 Stripe reconcile**

- `last_reconcile_at` — ISO timestamp of last successful reconcile checkpoint
- `last_cursor`, `last_r01_mrr`, `last_scorecard_r01_mrr`, `crystal_value`

### `asset_state_store` (per asset, survives DAG runs)

Asset: `ops/goal-scorecard` (`file://…/reports/goal-scorecard-latest.json`)

- `watermark` — ISO timestamp of last successful scorecard
- `last_run_summary` — small JSON summary (MRR, crystal, evt id, ok)

Reconcile DAG declares the same asset as an **inlet** and may read the watermark.

## Anti-pattern note

**Do not use Airflow Variables for cursors, job IDs, or watermarks.**

| Bad | Why | Use instead |
|-----|-----|-------------|
| `Variable.get/set("last_cursor")` | Global; any DAG can overwrite; not scoped to TI/retry | `task_state_store` |
| `Variable.set("last_scorecard_at", …)` | Global watermark; race-prone | `asset_state_store` on the scorecard asset |
| XCom for “resume on retry” job ids | New TI identity per retry; not crash-safe for external jobs | `task_state_store` / `ResumableJobMixin` |

Variables remain appropriate for **shared config/secrets**, not per-run coordination state.

## Schedule notes

Both DAGs default to `@hourly`. Change `schedule=` in the DAG decorators to `@daily` if you only need a once-per-day scorecard/reconcile. `catchup=False` avoids backfill storms on first enable.

## Offline / no network

These DAG files do not require network at parse or design time. Workers only need local Node scripts and report paths. Shipping this tree without Airflow installed is supported; validate version with `af config version` once Airflow is available.
