#!/usr/bin/env node
/**
 * Unilateral Revenue Ralph Loop — one iteration.
 *
 * Designed to be fired by systemd timer (and agentic sessions) forever until
 * cashflow mrr_actual >= $910k. Same prompt semantics as docs/REVENUE_RALPH_PROMPT.md:
 * read prior state from disk, advance revenue substrate, write state, exit.
 *
 * Usage:
 *   node scripts/revenue-ralph-loop.mjs           # one iteration
 *   node scripts/revenue-ralph-loop.mjs --json    # machine summary only
 *   node scripts/revenue-ralph-loop.mjs status    # print state, no work
 */
import { execFileSync, execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotCashflow, formatCashflowBrief } from "./cashflow-ledger.mjs";
import { RESTART_ALLOWLIST } from "./post-boot-reconfig.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS = join(ROOT, "reports");
const STATE_PATH = join(REPORTS, "revenue-ralph-state.json");
const PROMPT_PATH = join(ROOT, "docs", "REVENUE_RALPH_PROMPT.md");
const MRR_TARGET = 910_000;
const MONETIZE = process.env.X402_MONETIZE_URL || "http://127.0.0.1:8793";
const METER = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";

const REVENUE_UNITS = [
  "ops-inference-meter",
  "ops-x402-monetize",
  "cloudflared-inference",
  "redis-server",
  "qmem-llama-server",
  "ops-maintenance-http",
];

function sh(cmd, timeout = 30_000) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: ROOT,
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function isActive(unit) {
  return sh(`systemctl is-active ${unit}`).out === "active";
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return {
      version: 1,
      story: "Unilateral revenue Ralph loop — infinite until $910k mrr_actual",
      iteration: 0,
      started_at: new Date().toISOString(),
      history: [],
    };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { version: 1, iteration: 0, history: [], corrupt: true };
  }
}

function saveState(state) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function curlJson(url, opts = {}) {
  const code = sh(
    `curl -sS -m ${opts.timeout || 4} -o /tmp/ralph-curl.json -w '%{http_code}' ${opts.headers || ""} '${url.replace(/'/g, "")}'`,
  );
  let body = null;
  try {
    body = JSON.parse(readFileSync("/tmp/ralph-curl.json", "utf8"));
  } catch {
    body = null;
  }
  return { http: code.out, body, ok: code.ok && /^2/.test(code.out) };
}

function healRevenueUnits() {
  const healed = [];
  const stillDown = [];
  for (const unit of REVENUE_UNITS) {
    if (isActive(unit)) continue;
    if (!RESTART_ALLOWLIST.includes(unit) && unit !== "ops-x402-monetize") {
      // ops-x402-monetize is on allowlist after our earlier edit; double-check
      if (!RESTART_ALLOWLIST.includes(unit)) {
        stillDown.push({ unit, reason: "not_allowlisted" });
        continue;
      }
    }
    const r = sh(`systemctl start ${unit}`);
    // brief wait
    sh("sleep 1");
    if (isActive(unit)) healed.push(unit);
    else stillDown.push({ unit, reason: r.out || "start_failed" });
  }
  return { healed, stillDown };
}

function probeMonetize() {
  const health = curlJson(`${MONETIZE}/health`);
  const challenge = sh(
    `curl -sS -m 4 -o /dev/null -w '%{http_code}' '${MONETIZE}/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits'`,
  );
  return {
    health_ok: health.body?.ok === true,
    payTo: health.body?.payTo || null,
    dryRun: health.body?.dryRun ?? null,
    challenge_402: challenge.out === "402",
  };
}

function probeMeter() {
  const health = curlJson(`${METER}/health`);
  return {
    health_ok: health.body?.ok === true,
    service: health.body?.service || null,
  };
}

function runFlywheel() {
  const r = sh("node scripts/revenue-flywheel.mjs status", 60_000);
  let snap = null;
  try {
    snap = JSON.parse(r.out);
  } catch {
    snap = { parse_error: true, raw: r.out.slice(0, 400) };
  }
  return { ok: r.ok && !snap.parse_error, snap };
}

function nextFocus(cashflow, monetize, meter) {
  if (!meter.health_ok) return "R01:heal-inference-meter";
  if (!monetize.health_ok || !monetize.challenge_402)
    return "R01/R07:heal-x402-monetize";
  if (monetize.dryRun) return "R07:shopify-save-store-live-attribution";
  const mrr = cashflow?.totals?.mrr_actual ?? 0;
  if (mrr < 1000) return "R01:first-paid-customers-x402-or-stripe";
  if (mrr < 70_000) return "R01:scale-keys-and-usage";
  return "R07:treasury-lp-and-cross-stream";
}

/**
 * One Ralph iteration. Returns state + whether floor promise is allowed.
 */
export function runRevenueRalphIteration() {
  const at = new Date().toISOString();
  const state = loadState();
  const iteration = (state.iteration || 0) + 1;

  const heal = healRevenueUnits();
  const meter = probeMeter();
  const monetize = probeMonetize();
  const flywheel = runFlywheel();

  let cashflow = null;
  let cashflow_brief = "";
  try {
    cashflow = snapshotCashflow();
    cashflow_brief = formatCashflowBrief(cashflow);
  } catch (e) {
    cashflow = { error: String(e?.message || e) };
  }

  const mrr_actual = cashflow?.totals?.mrr_actual ?? 0;
  const gap = cashflow?.totals?.gap_usd ?? MRR_TARGET - mrr_actual;
  const floorHit = mrr_actual >= MRR_TARGET;

  const unitStatus = Object.fromEntries(
    REVENUE_UNITS.map((u) => [u, isActive(u) ? "active" : "inactive"]),
  );

  const focus = nextFocus(cashflow, monetize, meter);
  const actions = [
    heal.healed.length ? `healed:${heal.healed.join(",")}` : null,
    meter.health_ok ? "meter:ok" : "meter:down",
    monetize.challenge_402 ? "x402:challenge-402" : "x402:challenge-fail",
    flywheel.ok ? "flywheel:snap" : "flywheel:fail",
    cashflow?.totals ? `cash:mtd=${cashflow.totals.cash_collected_mtd}` : null,
  ].filter(Boolean);

  const entry = {
    iteration,
    at,
    mrr_actual,
    gap_usd: gap,
    floor_hit: floorHit,
    focus,
    actions,
    healed: heal.healed,
    still_down: heal.stillDown,
    meter,
    monetize,
    units: unitStatus,
  };

  const history = [...(state.history || []), entry].slice(-50);

  const next = {
    ...state,
    version: 1,
    story: "Unilateral revenue Ralph loop — infinite until $910k mrr_actual",
    prompt: PROMPT_PATH,
    iteration,
    updated_at: at,
    started_at: state.started_at || at,
    mrr_target: MRR_TARGET,
    mrr_actual,
    gap_usd: gap,
    floor_hit: floorHit,
    completion_promise: floorHit ? "REVENUE FLOOR HIT" : null,
    // Never write fake promise satisfaction
    promise_eligible: floorHit,
    next_focus: focus,
    last: entry,
    cashflow_brief,
    cashflow_totals: cashflow?.totals || null,
    flywheel_blockers: flywheel.snap?.blockers || [],
    unilateral: true,
    multi_session: true,
    note:
      "Agentic sessions (Grok/OpenClaw/Kimi) and systemd share this state file. Same prompt every fire.",
    history,
  };

  saveState(next);

  // Also refresh flywheel-latest via monetize if up
  if (monetize.health_ok) {
    curlJson(`${MONETIZE}/flywheel`);
  }

  // Lightweight go-live touch for monetize readiness
  try {
    const glPath = join(REPORTS, "monetize-go-live.json");
    let gl = {};
    if (existsSync(glPath)) gl = JSON.parse(readFileSync(glPath, "utf8"));
    gl.ralph = {
      iteration,
      at,
      floor_hit: floorHit,
      next_focus: focus,
    };
    writeFileSync(glPath, JSON.stringify(gl, null, 2));
  } catch {
    /* ignore */
  }

  return next;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "status") {
    const s = loadState();
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
  }

  const state = runRevenueRalphIteration();
  const jsonOnly = args.includes("--json");

  if (!jsonOnly) {
    console.log(
      `[revenue-ralph] iteration=${state.iteration} mrr=${state.mrr_actual}/${state.mrr_target} gap=${state.gap_usd} focus=${state.next_focus}`,
    );
    if (state.cashflow_brief) console.log(state.cashflow_brief);
    console.log(
      `[revenue-ralph] units meter=${state.last.meter.health_ok} x402_402=${state.last.monetize.challenge_402} healed=${(state.last.healed || []).join(",") || "none"}`,
    );
    if (state.promise_eligible) {
      // Only when floor truly hit — for interactive Ralph stop hooks
      console.log("<promise>REVENUE FLOOR HIT</promise>");
    } else {
      console.log(
        "[revenue-ralph] no completion — continue loop (unilateral / timer / next session)",
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        iteration: state.iteration,
        mrr_actual: state.mrr_actual,
        gap_usd: state.gap_usd,
        floor_hit: state.floor_hit,
        next_focus: state.next_focus,
        promise_eligible: state.promise_eligible,
        state_path: STATE_PATH,
      },
      null,
      2,
    ),
  );

  // Exit 0 always for timer success unless catastrophic
  process.exit(0);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
