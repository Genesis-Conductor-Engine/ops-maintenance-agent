"""
ops_goal_scorecard — diamondnode revenue + goal scorecard cycle.

Airflow 3.3+ (AIP-103): uses task_state_store for per-retry checkpoints
(last_cursor / last_evt_id, crystal_value, total_mrr_usd) and
asset_state_store for a cross-run watermark of the last successful scorecard.

Anti-pattern: do NOT use Variables for cursors or watermarks.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from airflow.sdk import Asset, dag, task
from pendulum import datetime as pendulum_datetime

# Repo root on the diamondnode host (override via env when needed).
OPS_ROOT = Path(os.environ.get("OPS_MAINTENANCE_ROOT", "/root/ops-maintenance-agent"))
GOAL_SCORECARD_SCRIPT = OPS_ROOT / "scripts" / "goal-scorecard.mjs"
PROCEDURAL_TRUTH_SCRIPT = OPS_ROOT / "scripts" / "procedural-truth.mjs"
SCORECARD_REPORT = OPS_ROOT / "reports" / "goal-scorecard-latest.json"
PROCEDURAL_TRUTH_REPORT = OPS_ROOT / "reports" / "procedural-truth-latest.json"

# Asset for cross-DAG / cross-run watermarks (asset_state_store).
GOAL_SCORECARD_ASSET = Asset(
    name="ops/goal-scorecard",
    uri=f"file://{SCORECARD_REPORT}",
)


def _run_node(script: Path, timeout: int = 120) -> dict:
    """Execute a Node script; parse trailing JSON line if present."""
    if not script.is_file():
        raise FileNotFoundError(f"Script not found: {script}")
    proc = subprocess.run(
        ["node", str(script)],
        cwd=str(OPS_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    parsed: dict | None = None
    if stdout:
        # Prefer last non-empty line that parses as JSON (scripts log a summary).
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if proc.returncode != 0:
        raise RuntimeError(
            f"{script.name} exited {proc.returncode}: "
            f"stderr={stderr[:2000]!r} stdout={stdout[:2000]!r}"
        )
    return parsed or {"ok": True, "stdout": stdout}


def _load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


@dag(
    dag_id="ops_goal_scorecard",
    start_date=pendulum_datetime(2026, 1, 1),
    schedule="@hourly",
    catchup=False,
    tags=["ops", "revenue", "goal-scorecard", "diamondnode"],
    doc_md=__doc__,
    default_args={"retries": 3},
)
def ops_goal_scorecard():
    """Hourly goal scorecard + optional procedural truth with AIP-103 state stores."""

    @task(retries=3)
    def run_procedural_truth_if_present(**context) -> dict:
        """
        Optional PTV step. Checkpoints last_evt_id / last_cursor in task_state_store
        so a retry resumes awareness of the last processed event id.
        """
        task_state_store = context["task_state_store"]
        last_evt_id = task_state_store.get("last_evt_id", default="")
        last_cursor = task_state_store.get("last_cursor", default=0)

        if not PROCEDURAL_TRUTH_SCRIPT.is_file():
            return {
                "skipped": True,
                "reason": "procedural-truth.mjs not present",
                "last_evt_id": last_evt_id,
                "last_cursor": last_cursor,
            }

        summary = _run_node(PROCEDURAL_TRUTH_SCRIPT, timeout=90)
        report = _load_json(PROCEDURAL_TRUTH_REPORT)
        report_summary = report.get("summary") or {}
        evt_id = (
            summary.get("evt_id")
            or report_summary.get("evt_id")
            or last_evt_id
            or ""
        )
        crystal = summary.get("crystal_value")
        if crystal is None:
            crystal = report_summary.get("crystal_value")

        new_cursor = int(last_cursor or 0) + 1
        task_state_store.set("last_cursor", new_cursor)
        if evt_id:
            task_state_store.set("last_evt_id", str(evt_id))
        if crystal is not None:
            task_state_store.set("crystal_value", float(crystal))

        return {
            "skipped": False,
            "ok": bool(summary.get("ok", report_summary.get("ok", True))),
            "evt_id": evt_id,
            "crystal_value": crystal,
            "last_cursor": new_cursor,
        }

    @task(retries=3)
    def run_goal_scorecard(**context) -> dict:
        """
        Run goal-scorecard.mjs; checkpoint crystal_value + total_mrr_usd and
        last_cursor / last_evt_id in task_state_store (survives retries).
        """
        task_state_store = context["task_state_store"]

        last_cursor = task_state_store.get("last_cursor", default=0)
        last_evt_id = task_state_store.get("last_evt_id", default="")

        summary = _run_node(GOAL_SCORECARD_SCRIPT, timeout=120)
        report = _load_json(SCORECARD_REPORT)

        ptv = report.get("procedural_truth") or summary.get("ptv") or {}
        totals = report.get("totals") or {}
        crystal_value = ptv.get("crystal_value")
        if crystal_value is None and "crystal_value" in summary:
            crystal_value = summary.get("crystal_value")
        total_mrr_usd = totals.get("total_mrr_usd", summary.get("total_mrr_usd", 0))
        evt_id = ptv.get("evt_id") or last_evt_id or ""

        new_cursor = int(last_cursor or 0) + 1
        task_state_store.set("last_cursor", new_cursor)
        if evt_id:
            task_state_store.set("last_evt_id", str(evt_id))
        if crystal_value is not None:
            task_state_store.set("crystal_value", float(crystal_value))
        task_state_store.set("total_mrr_usd", float(total_mrr_usd or 0))

        completed_at = report.get("at") or datetime.now(tz=timezone.utc).isoformat()
        return {
            "completed_at": completed_at,
            "crystal_value": crystal_value,
            "total_mrr_usd": total_mrr_usd,
            "streams_at_floor": totals.get("streams_at_floor"),
            "pct_to_combined_floor": totals.get("pct_to_combined_floor"),
            "last_cursor": new_cursor,
            "last_evt_id": evt_id,
            "ok": bool(report.get("ok", summary.get("ok", True))),
            "report_path": str(SCORECARD_REPORT),
        }

    @task(outlets=[GOAL_SCORECARD_ASSET])
    def publish_scorecard_watermark(summary: dict, asset_state_store=None) -> dict:
        """
        Persist last successful scorecard ISO timestamp on asset_state_store.
        Declared without **context so Airflow injects asset_state_store cleanly.
        """
        store = asset_state_store[GOAL_SCORECARD_ASSET]
        completed_at = summary.get("completed_at") or datetime.now(
            tz=timezone.utc
        ).isoformat()
        store.set("watermark", completed_at)
        store.set(
            "last_run_summary",
            {
                "completed_at": completed_at,
                "crystal_value": summary.get("crystal_value"),
                "total_mrr_usd": summary.get("total_mrr_usd"),
                "streams_at_floor": summary.get("streams_at_floor"),
                "pct_to_combined_floor": summary.get("pct_to_combined_floor"),
                "last_evt_id": summary.get("last_evt_id"),
                "ok": bool(summary.get("ok", True)),
            },
        )
        return {"watermark": completed_at, "asset": "ops/goal-scorecard"}

    ptv = run_procedural_truth_if_present()
    scorecard = run_goal_scorecard()
    watermark = publish_scorecard_watermark(scorecard)
    ptv >> scorecard >> watermark


ops_goal_scorecard()
