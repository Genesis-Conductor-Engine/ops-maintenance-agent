#!/usr/bin/env node
/**
 * Goal scorecard: 13 streams @ $70k MRR floor + procedural truth + R01 readiness.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STREAMS = 13;
const FLOOR = 70_000;
const COMBINED = STREAMS * FLOOR;
const PTV =
  process.env.PTV_SCRIPT ||
  "/home/diamondnode/genesis_conductor_engine/swarm/procedural_truth_verifier.py";

const STREAM_IDS = [
  "R01", "R02", "R03", "R04", "R05", "R06", "R07",
  "R08", "R09", "R10", "R11", "R12", "R13",
];

function runPtv() {
  try {
    const out = execFileSync(
      "python3",
      [PTV, "--source", "goal-scorecard", "--json"],
      {
        encoding: "utf8",
        timeout: 60_000,
        cwd: "/home/diamondnode/genesis_conductor_engine/swarm",
      }
    );
    const evt = JSON.parse(out);
    const cs = evt.crystal_score || {};
    return {
      ok: Boolean(cs.passed),
      crystal_value: cs.value,
      evt_id: evt.evt_id,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function loadR01() {
  const p = join(ROOT, "reports", "r01-go-live.json");
  if (!existsSync(p)) return { estimated_mrr: 0, readiness: null };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { estimated_mrr: 0, readiness: null };
  }
}

function loadCashflow() {
  const p = join(ROOT, "reports", "cashflow-latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const ptv = runPtv();
  const r01 = loadR01();
  const cash = loadCashflow();

  const streamMrr = Object.fromEntries(
    STREAM_IDS.map((id) => {
      if (id === "R01") {
        return [id, Number(r01.revenue?.estimated_mrr ?? r01.estimated_mrr ?? 0)];
      }
      // Other streams: 0 until actuation modules book cash
      return [id, 0];
    })
  );

  const totalMrr = Object.values(streamMrr).reduce((a, b) => a + b, 0);
  const streamsAtFloor = Object.values(streamMrr).filter((v) => v >= FLOOR).length;
  const pctToCombined = Math.min(100, (totalMrr / COMBINED) * 100);

  const scorecard = {
    at: new Date().toISOString(),
    north_star: {
      streams: STREAMS,
      mrr_per_stream_usd: FLOOR,
      combined_mrr_floor_usd: COMBINED,
    },
    procedural_truth: ptv,
    streams: streamMrr,
    totals: {
      total_mrr_usd: totalMrr,
      streams_at_floor: streamsAtFloor,
      streams_total: STREAMS,
      pct_to_combined_floor: Number(pctToCombined.toFixed(3)),
    },
    r01_readiness: r01.readiness || null,
    r01_blockers: r01.go_live_blockers || [],
    cashflow_backend: cash?.backend || null,
    priorities: {
      revenue_activation: streamsAtFloor === 0 ? "P0" : "P1",
      ai_infra_automation: ptv.ok ? "P1" : "P0",
      personal_ops_balance: "P2",
    },
    goals: {
      financial_infrastructure: `${streamsAtFloor}/${STREAMS} streams ≥ $${FLOOR}`,
      intrinsic_pursuit: ptv.ok
        ? `procedural truth PASS crystal=${ptv.crystal_value}`
        : "procedural truth FAIL",
      hybridization: "OpenClaw/Kimi + diamondnode loopbacks active when ptv.ok",
      professional_role: "Lead AI Systems Architect / Kovach Enterprises",
    },
    ok: Boolean(ptv.ok),
  };

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const path = join(ROOT, "reports", "goal-scorecard-latest.json");
  writeFileSync(path, JSON.stringify(scorecard, null, 2));
  console.log(JSON.stringify({ path, ...scorecard.totals, ptv: scorecard.procedural_truth, ok: scorecard.ok }));
  process.exit(scorecard.ok ? 0 : 1);
}

main();
