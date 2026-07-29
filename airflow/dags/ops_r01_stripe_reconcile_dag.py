"""
ops_r01_stripe_reconcile — checkpointed R01 Stripe / readiness reconcile.

Reads reports/r01-go-live.json and reports/goal-scorecard-latest.json, compares
readiness/revenue vs scorecard R01 stream, and checkpoints last_reconcile_at
in task_state_store so retries resume from the last successful checkpoint.

Airflow 3.3+ (AIP-103). Do NOT store last_reconcile_at in Variables.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from airflow.sdk import Asset, dag, task
from pendulum import datetime as pendulum_datetime

OPS_ROOT = Path(os.environ.get("OPS_MAINTENANCE_ROOT", "/root/ops-maintenance-agent"))
R01_GO_LIVE = OPS_ROOT / "reports" / "r01-go-live.json"
GOAL_SCORECARD = OPS_ROOT / "reports" / "goal-scorecard-latest.json"
RECONCILE_OUT = OPS_ROOT / "reports" / "r01-stripe-reconcile-latest.json"

GOAL_SCORECARD_ASSET = Asset(
    name="ops/goal-scorecard",
    uri=f"file://{GOAL_SCORECARD}",
)


def _load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"_load_error": str(exc)}


@dag(
    dag_id="ops_r01_stripe_reconcile",
    start_date=pendulum_datetime(2026, 1, 1),
    schedule="@hourly",
    catchup=False,
    tags=["ops", "revenue", "R01", "stripe", "reconcile"],
    doc_md=__doc__,
    default_args={"retries": 3},
)
def ops_r01_stripe_reconcile():
    """Reconcile R01 go-live snapshot against latest goal scorecard with checkpoints."""

    @task(inlets=[GOAL_SCORECARD_ASSET])
    def read_scorecard_watermark(asset_state_store=None) -> dict:
        """Read cross-run scorecard watermark from asset_state_store (no **context)."""
        watermark = None
        last_run_summary = None
        if asset_state_store is not None:
            store = asset_state_store[GOAL_SCORECARD_ASSET]
            watermark = store.get("watermark", default=None)
            last_run_summary = store.get("last_run_summary", default=None)
        return {
            "scorecard_watermark": watermark,
            "last_run_summary": last_run_summary,
        }

    @task(retries=3)
    def reconcile_r01(asset_meta: dict, **context) -> dict:
        """
        Compare r01-go-live + goal-scorecard-latest; checkpoint last_reconcile_at
        in task_state_store (not Variables).
        """
        task_state_store = context["task_state_store"]

        last_reconcile_at = task_state_store.get("last_reconcile_at", default="")
        last_cursor = task_state_store.get("last_cursor", default=0)

        r01 = _load_json(R01_GO_LIVE)
        scorecard = _load_json(GOAL_SCORECARD)

        if r01.get("_load_error") or not r01:
            raise FileNotFoundError(
                f"Missing or unreadable R01 snapshot: {R01_GO_LIVE}"
            )
        if scorecard.get("_load_error") or not scorecard:
            raise FileNotFoundError(
                f"Missing or unreadable goal scorecard: {GOAL_SCORECARD}"
            )

        scorecard_watermark = (asset_meta or {}).get("scorecard_watermark")

        r01_mrr = float(
            (r01.get("revenue") or {}).get("estimated_mrr")
            or r01.get("estimated_mrr")
            or 0
        )
        scorecard_r01 = float((scorecard.get("streams") or {}).get("R01") or 0)
        scorecard_total = float(
            (scorecard.get("totals") or {}).get("total_mrr_usd") or 0
        )
        crystal_value = (scorecard.get("procedural_truth") or {}).get("crystal_value")

        readiness = r01.get("readiness") or {}
        blockers = list(r01.get("go_live_blockers") or scorecard.get("r01_blockers") or [])
        stripe_webhook_ok = bool(readiness.get("stripe_webhook_secret"))
        stripe_checkout_ok = bool(readiness.get("stripe_checkout_urls_any"))
        public_edge_ok = bool(readiness.get("public_edge_ok"))

        mrr_delta = abs(r01_mrr - scorecard_r01)
        mrr_aligned = mrr_delta < 0.01

        now = datetime.now(tz=timezone.utc).isoformat()
        result = {
            "ok": mrr_aligned and public_edge_ok,
            "reconciled_at": now,
            "previous_reconcile_at": last_reconcile_at or None,
            "scorecard_watermark": scorecard_watermark,
            "r01": {
                "at": r01.get("at"),
                "estimated_mrr": r01_mrr,
                "active_keys": (r01.get("revenue") or {}).get("active_keys"),
                "public_base_url": (r01.get("endpoints") or {}).get("public_base_url"),
                "stripe_webhook_secret": stripe_webhook_ok,
                "stripe_checkout_urls_any": stripe_checkout_ok,
                "public_edge_ok": public_edge_ok,
                "blockers": blockers,
            },
            "scorecard": {
                "at": scorecard.get("at"),
                "R01_mrr_usd": scorecard_r01,
                "total_mrr_usd": scorecard_total,
                "crystal_value": crystal_value,
            },
            "checks": {
                "mrr_aligned": mrr_aligned,
                "mrr_delta_usd": mrr_delta,
                "stripe_webhook_configured": stripe_webhook_ok,
                "stripe_checkout_configured": stripe_checkout_ok,
                "public_edge_ok": public_edge_ok,
            },
            "paths": {
                "r01_go_live": str(R01_GO_LIVE),
                "goal_scorecard": str(GOAL_SCORECARD),
            },
        }

        new_cursor = int(last_cursor or 0) + 1
        task_state_store.set("last_cursor", new_cursor)
        task_state_store.set("last_reconcile_at", now)
        task_state_store.set("last_r01_mrr", r01_mrr)
        task_state_store.set("last_scorecard_r01_mrr", scorecard_r01)
        if crystal_value is not None:
            task_state_store.set("crystal_value", float(crystal_value))

        RECONCILE_OUT.parent.mkdir(parents=True, exist_ok=True)
        RECONCILE_OUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        result["report_path"] = str(RECONCILE_OUT)
        result["last_cursor"] = new_cursor
        return result

    meta = read_scorecard_watermark()
    reconcile_r01(meta)


ops_r01_stripe_reconcile()
