#!/usr/bin/env node
/**
 * Post-boot reconfig + heal for diamondnode.
 * Analyzes crash/boot state, restarts allowlisted services (never ssh/sshd),
 * waits for openclaw-gateway, runs verification, notifies Kimi, writes reports.
 *
 * CLI: node scripts/post-boot-reconfig.mjs [--force-heal]
 * Exit: 0 if all allowlisted end active; 2 if any still down after heal.
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrashAnalysis } from "./crash-analyze.mjs";
import { runVerification, formatMarkdown } from "./verify.mjs";
import { sendKimiUpdate, buildMessage } from "./kimi-update.mjs";

/** Safe restart allowlist — NEVER include ssh or sshd. */
const RESTART_ALLOWLIST = [
  "openclaw-gateway",
  "ollama",
  "nginx",
  "diamond-gateway",
  "redis-server",
  "qmem-llama-server",
  "qmem-sync",
  "genesis-ops-stream",
  "cloudflared",
  "cloudflared-inference",
  "ops-maintenance-http",
  "ops-inference-meter",
];

const FORBIDDEN = new Set(["ssh", "sshd", "ssh.service", "sshd.service"]);

function assertNoSsh(list) {
  for (const u of list) {
    const base = String(u).replace(/\.service$/i, "").toLowerCase();
    if (FORBIDDEN.has(base) || FORBIDDEN.has(u)) {
      throw new Error(`FATAL: ssh/sshd must never be in RESTART_ALLOWLIST (got ${u})`);
    }
  }
}
assertNoSsh(RESTART_ALLOWLIST);

function sh(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        timeout: opts.timeout ?? 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function normalizeUnit(name) {
  return String(name || "")
    .replace(/\.service$/i, "")
    .replace(/\.socket$/i, "")
    .replace(/\.timer$/i, "")
    .trim();
}

function isActive(unit) {
  const r = sh(`systemctl is-active ${unit}`);
  return r.out === "active";
}

function getActiveState(unit) {
  const r = sh(`systemctl is-active ${unit}`);
  return r.out || "unknown";
}

function enableUnit(unit) {
  // Ignore errors (unit may not exist or already enabled)
  return sh(`systemctl enable ${unit} 2>/dev/null || true`);
}

function restartUnit(unit) {
  if (FORBIDDEN.has(normalizeUnit(unit).toLowerCase()) || FORBIDDEN.has(unit)) {
    return { ok: false, out: "refused: ssh/sshd never restarted" };
  }
  return sh(`systemctl restart ${unit}`, { timeout: 90_000 });
}

function sleepMs(ms) {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  sh(`sleep ${sec}`, { timeout: (sec + 5) * 1000 });
}

function waitForActive(unit, { maxMs = 30_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (isActive(unit)) return true;
    sleepMs(intervalMs);
  }
  return isActive(unit);
}

function failedUnitSet(analysisReport) {
  const units = analysisReport?.failed_units?.units || [];
  const set = new Set();
  for (const u of units) {
    set.add(u);
    set.add(normalizeUnit(u));
    set.add(`${normalizeUnit(u)}.service`);
  }
  return set;
}

/**
 * Heal a single allowlisted unit.
 * @returns {{ unit, before, after, action }}
 */
function healUnit(unit, { forceHeal, failedSet }) {
  enableUnit(unit);
  const before = getActiveState(unit);
  const inFailed =
    failedSet.has(unit) ||
    failedSet.has(normalizeUnit(unit)) ||
    failedSet.has(`${normalizeUnit(unit)}.service`);
  const needsRestart = before !== "active" || inFailed || forceHeal;

  let action = "none";
  if (needsRestart) {
    if (before !== "active" && inFailed) action = "restart (inactive+failed)";
    else if (before !== "active") action = "restart (inactive)";
    else if (inFailed) action = "restart (failed list)";
    else if (forceHeal) action = "restart (force-heal)";
    else action = "restart";

    restartUnit(unit);
  } else {
    action = "already-active";
  }

  const after = getActiveState(unit);
  return { unit, before, after, action };
}

function ensureRunning(unit, label) {
  const before = getActiveState(unit);
  if (before === "active") {
    return { unit, before, after: before, action: `ensure ${label}: already-active` };
  }
  enableUnit(unit);
  restartUnit(unit);
  const after = getActiveState(unit);
  return {
    unit,
    before,
    after,
    action: `ensure ${label}: restart`,
  };
}

function buildBootMessage(analysis, healed, verificationReport, forceHeal) {
  const healedList = healed
    .filter((h) => h.action && !h.action.includes("already-active") && h.action !== "none")
    .map((h) => `${h.unit}: ${h.before}→${h.after} (${h.action})`);
  const stillDown = healed.filter((h) => h.after !== "active").map((h) => h.unit);

  const extra = [
    `Post-boot reconfig @ diamondnode`,
    `Analysis severity: ${analysis?.severity ?? "unknown"}`,
    `Force heal: ${forceHeal ? "yes" : "no"}`,
    `Boot id: ${analysis?.boot?.boot_id ?? "?"}`,
    `Boot time: ${analysis?.boot?.boot_time ?? "?"}`,
    `Healed (${healedList.length}):`,
    ...(healedList.length ? healedList.map((l) => `  - ${l}`) : ["  - none needed"]),
    stillDown.length ? `Still down: ${stillDown.join(", ")}` : "All allowlisted active: yes",
    analysis?.reasons?.length
      ? `Reasons: ${analysis.reasons.slice(0, 5).join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return buildMessage(verificationReport, extra);
}

/**
 * @param {{ forceHeal?: boolean }} opts
 * @returns {{ report, path, latest, exitCode }}
 */
export function runPostBootReconfig(opts = {}) {
  const forceHeal = Boolean(opts.forceHeal);
  const at = new Date().toISOString();
  const healed = [];

  console.log("[post-boot] crash analysis…");
  const { report: analysis } = runCrashAnalysis();
  console.log(
    `[post-boot] severity=${analysis.severity} failed=${analysis.failed_units?.count ?? 0} forceHeal=${forceHeal}`
  );

  const failedSet = failedUnitSet(analysis);

  console.log("[post-boot] heal allowlisted services…");
  for (const unit of RESTART_ALLOWLIST) {
    const result = healUnit(unit, { forceHeal, failedSet });
    healed.push(result);
    console.log(
      `  ${result.unit}: ${result.before} → ${result.after} [${result.action}]`
    );
  }

  // Explicit ensures (may already be covered by allowlist loop)
  console.log("[post-boot] ensure ops-maintenance-http…");
  const httpEnsure = ensureRunning("ops-maintenance-http", "ops-http");
  if (
    !healed.some(
      (h) =>
        h.unit === "ops-maintenance-http" &&
        h.action === httpEnsure.action &&
        h.after === httpEnsure.after
    )
  ) {
    // Merge latest state for ops-maintenance-http into healed records
    const idx = healed.findIndex((h) => h.unit === "ops-maintenance-http");
    if (idx >= 0 && httpEnsure.after === "active" && healed[idx].after !== "active") {
      healed[idx] = {
        ...healed[idx],
        after: httpEnsure.after,
        action: `${healed[idx].action}; ${httpEnsure.action}`,
      };
    } else if (idx >= 0 && httpEnsure.action.includes("restart")) {
      healed[idx] = {
        unit: "ops-maintenance-http",
        before: healed[idx].before,
        after: httpEnsure.after,
        action: `${healed[idx].action}; ${httpEnsure.action}`,
      };
    }
  }

  console.log("[post-boot] ensure openclaw-gateway + wait ≤30s…");
  const gwBefore = getActiveState("openclaw-gateway");
  if (gwBefore !== "active") {
    enableUnit("openclaw-gateway");
    restartUnit("openclaw-gateway");
  }
  const gwOk = waitForActive("openclaw-gateway", { maxMs: 30_000, intervalMs: 2_000 });
  const gwAfter = getActiveState("openclaw-gateway");
  const gwIdx = healed.findIndex((h) => h.unit === "openclaw-gateway");
  if (gwIdx >= 0) {
    healed[gwIdx] = {
      unit: "openclaw-gateway",
      before: healed[gwIdx].before,
      after: gwAfter,
      action: gwOk
        ? `${healed[gwIdx].action}; wait-active OK`
        : `${healed[gwIdx].action}; wait-active TIMEOUT`,
    };
  }
  console.log(`  openclaw-gateway: ${gwAfter} (wait ok=${gwOk})`);

  console.log("[post-boot] verification…");
  let verification_ok = false;
  let verificationReport = null;
  try {
    const { report } = runVerification();
    verificationReport = report;
    verification_ok = Boolean(report?.summary?.ok);
    console.log(formatMarkdown(report));
  } catch (e) {
    console.error("[post-boot] verification error:", e?.message || e);
    verification_ok = false;
  }

  const healedNames = healed
    .filter((h) => h.action && !String(h.action).includes("already-active"))
    .map((h) => h.unit);

  console.log("[post-boot] kimi update…");
  let kimi = { ok: false, channel: "none", detail: "skipped" };
  try {
    const msg = buildBootMessage(analysis, healed, verificationReport, forceHeal);
    kimi = sendKimiUpdate(msg);
    console.log(JSON.stringify(kimi, null, 2));
  } catch (e) {
    kimi = { ok: false, channel: "none", detail: String(e?.message || e) };
    console.error("[post-boot] kimi error:", kimi.detail);
  }

  const allowlistedActive = RESTART_ALLOWLIST.every((u) => isActive(u));
  // Re-sample final states into report (source of truth for exit)
  const finalHealed = RESTART_ALLOWLIST.map((unit) => {
    const prev = healed.find((h) => h.unit === unit) || {
      unit,
      before: "unknown",
      action: "none",
    };
    return {
      unit: prev.unit,
      before: prev.before,
      after: getActiveState(unit),
      action: prev.action,
    };
  });

  const allActive = finalHealed.every((h) => h.after === "active");
  const exitCode = allActive ? 0 : 2;

  const report = {
    at,
    analysis_severity: analysis?.severity ?? "unknown",
    healed: finalHealed,
    verification_ok,
    kimi,
    force_heal: forceHeal,
    // extras for operators
    allowlisted_active: allActive,
    healed_units: healedNames,
    boot: analysis?.boot ?? null,
    failed_units: analysis?.failed_units?.units ?? [],
    reasons: analysis?.reasons ?? [],
    exit_code: exitCode,
  };

  const outDir = join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const isoSafe = at.replace(/[:.]/g, "-");
  const stamped = join(outDir, `post-boot-${isoSafe}.json`);
  const latest = join(outDir, "post-boot-latest.json");
  const body = JSON.stringify(report, null, 2);
  writeFileSync(stamped, body);
  writeFileSync(latest, body);
  console.log(`[post-boot] wrote ${stamped}`);
  console.log(`[post-boot] wrote ${latest}`);
  console.log(`[post-boot] exit_code=${exitCode} all_active=${allActive}`);

  return { report, path: stamped, latest, exitCode };
}

function isMain() {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? join(process.argv[1]) : "";
    return (
      thisFile === argv1 ||
      process.argv[1]?.endsWith("post-boot-reconfig.mjs") ||
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    return process.argv[1]?.endsWith("post-boot-reconfig.mjs");
  }
}

if (isMain()) {
  const forceHeal = process.argv.includes("--force-heal");
  try {
    // Ensure cwd is package root when invoked via absolute path
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    try {
      process.chdir(root);
    } catch {
      /* keep cwd */
    }
    const { exitCode } = runPostBootReconfig({ forceHeal });
    process.exit(exitCode);
  } catch (e) {
    console.error("[post-boot] fatal:", e?.message || e);
    process.exit(2);
  }
}

export { RESTART_ALLOWLIST };
