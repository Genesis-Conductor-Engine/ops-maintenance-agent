#!/usr/bin/env node
/**
 * One full maintenance cycle:
 * 1. verify diamondnode
 * 2. inventory PR babysit (all open PRs when gh auth present)
 * 3. on critical/core-down: crash analysis (+ force-heal if allowlisted inactive)
 * 4. push Kimi mobile update
 *
 * Healthy path skips analysis/heal. Never restarts ssh.
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runVerification, formatMarkdown } from "./verify.mjs";
import { runPrBabysitAll } from "./pr-babysit.mjs";
import { sendKimiUpdate, buildMessage } from "./kimi-update.mjs";
import { runCrashAnalysis } from "./crash-analyze.mjs";
import { runPostBootReconfig, RESTART_ALLOWLIST } from "./post-boot-reconfig.mjs";
import {
  snapshotCashflow,
  formatCashflowBrief,
} from "./cashflow-ledger.mjs";
import {
  runDeploymentsAudit,
  formatDeployBrief,
} from "./deployments-audit.mjs";

function isUnitActive(unit) {
  try {
    const out = execSync(`systemctl is-active ${unit}`, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "active";
  } catch {
    return false;
  }
}

function listInactiveAllowlisted() {
  return RESTART_ALLOWLIST.filter((u) => !isUnitActive(u));
}

function anyCoreServiceInactive(report) {
  // Prefer live allowlist check (includes ops-maintenance-http; never heals ssh)
  if (listInactiveAllowlisted().length > 0) return true;
  const services = report?.services || {};
  for (const [name, state] of Object.entries(services)) {
    if (name === "ssh" || name === "sshd") continue; // observed only, never heal
    if (state !== "active") return true;
  }
  return false;
}

async function main() {
  console.log("[cycle] verification…");
  const { report } = runVerification();
  console.log(formatMarkdown(report));

  console.log("[cycle] pr-babysit all…");
  const pr = runPrBabysitAll();
  console.log(JSON.stringify(pr, null, 2));

  const criticalBlocked = report.summary.criticalBlocked || [];
  const verificationCriticalFail =
    !report.summary.ok || criticalBlocked.length > 0;
  const coreDown = anyCoreServiceInactive(report);
  const inactiveAllowlisted = listInactiveAllowlisted();
  const needsAnalysis = coreDown || verificationCriticalFail;
  const needsHeal = inactiveAllowlisted.length > 0;

  let crash_analysis = null;
  let post_boot = null;

  if (needsAnalysis) {
    console.log(
      `[cycle] critical path: coreDown=${coreDown} criticalBlocked=${criticalBlocked.length} inactiveAllowlisted=${inactiveAllowlisted.join(",") || "none"}`
    );
    console.log("[cycle] crash analysis…");
    try {
      const { report: analysis } = runCrashAnalysis();
      crash_analysis = {
        severity: analysis.severity,
        reboot_recommended: analysis.reboot_recommended,
        failed_units: analysis.failed_units?.units || [],
        core_failed: analysis.failed_units?.core_failed || [],
        reasons: analysis.reasons || [],
        boot_id: analysis.boot?.boot_id,
      };
      console.log(
        `[cycle] analysis severity=${crash_analysis.severity} failed=${crash_analysis.failed_units.length}`
      );
    } catch (e) {
      crash_analysis = { error: String(e?.message || e), severity: "warn" };
      console.error("[cycle] crash analysis error:", crash_analysis.error);
    }

    // Heal only when allowlisted units are inactive (never on healthy path)
    if (needsHeal) {
      console.log(
        `[cycle] post-boot force-heal for inactive: ${inactiveAllowlisted.join(", ")}`
      );
      try {
        const { report: healReport, exitCode } = runPostBootReconfig({
          forceHeal: true,
        });
        post_boot = {
          exit_code: exitCode,
          allowlisted_active: healReport.allowlisted_active,
          analysis_severity: healReport.analysis_severity,
          healed_units: healReport.healed_units || [],
          verification_ok: healReport.verification_ok,
          force_heal: true,
        };
        console.log(
          `[cycle] heal exit=${exitCode} all_active=${healReport.allowlisted_active}`
        );
      } catch (e) {
        post_boot = { error: String(e?.message || e), force_heal: true };
        console.error("[cycle] post-boot heal error:", post_boot.error);
      }
    } else {
      console.log("[cycle] skip heal (all allowlisted services active)");
    }
  } else {
    console.log("[cycle] healthy path — skip crash analysis and heal");
  }

  console.log("[cycle] cashflow ledger…");
  try {
    const rev = sh("curl -sS -m 3 http://127.0.0.1:8792/health");
    if (rev.ok) console.log("[cycle] inference-meter: " + rev.out.slice(0, 120));
  } catch { /* optional */ }
  let cashflow = null;
  let cashflow_brief = "";
  try {
    cashflow = snapshotCashflow();
    cashflow_brief = formatCashflowBrief(cashflow);
    console.log(cashflow_brief);
  } catch (e) {
    cashflow = { error: String(e?.message || e) };
    console.error("[cycle] cashflow error:", cashflow.error);
  }

  console.log("[cycle] deployments audit…");
  let deployments = null;
  let deploy_brief = "";
  try {
    const { report: depReport } = await runDeploymentsAudit();
    deployments = {
      ok: depReport.summary?.ok,
      summary: depReport.summary,
      p0_attention: depReport.summary?.p0_attention || [],
      failure_hints: (depReport.failure_hints || []).map((h) => h.project),
    };
    deploy_brief = formatDeployBrief(depReport);
    console.log(deploy_brief);
  } catch (e) {
    deployments = { error: String(e?.message || e) };
    console.error("[cycle] deployments audit error:", deployments.error);
  }

  const extraParts = [
    cashflow_brief || "Cashflow: unavailable",
    deploy_brief || "Deploy audit: unavailable",
    `PR babysit: ${pr.ok ? `watching ${pr.watched}` : `BLOCKED (${pr.blocked})`}`,
    pr.message || "",
  ];
  if (crash_analysis) {
    extraParts.push(
      `Crash analysis: severity=${crash_analysis.severity}` +
        (crash_analysis.failed_units?.length
          ? ` failed=[${crash_analysis.failed_units.join(", ")}]`
          : " failed=none") +
        (crash_analysis.reasons?.length
          ? ` reasons: ${crash_analysis.reasons.slice(0, 3).join("; ")}`
          : "")
    );
  }
  if (post_boot) {
    extraParts.push(
      post_boot.error
        ? `Heal: ERROR ${post_boot.error}`
        : `Heal: force=${post_boot.force_heal} all_active=${post_boot.allowlisted_active} units=${(post_boot.healed_units || []).join(",") || "none"} exit=${post_boot.exit_code}`
    );
  } else if (needsAnalysis && !needsHeal) {
    extraParts.push("Heal: skipped (all allowlisted active)");
  }

  const extra = extraParts.filter(Boolean).join("\n");

  const msg = buildMessage(report, extra);
  console.log("[cycle] kimi update…");
  const kimi = sendKimiUpdate(msg);
  console.log(JSON.stringify(kimi, null, 2));

  const summary = {
    at: new Date().toISOString(),
    verification_ok: report.summary.ok,
    blocked: report.summary.blocked,
    critical_blocked: criticalBlocked,
    core_down: coreDown,
    inactive_allowlisted: inactiveAllowlisted,
    needs_analysis: needsAnalysis,
    needs_heal: needsHeal,
    crash_analysis,
    post_boot,
    cashflow: cashflow?.totals
      ? { totals: cashflow.totals, backend: cashflow.backend, updated_at: cashflow.updated_at }
      : cashflow,
    deployments,
    pr,
    kimi,
  };

  mkdirSync(join(process.cwd(), "reports"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "reports", "cycle-latest.json"),
    JSON.stringify(summary, null, 2)
  );

  // Non-zero only if critical services are down (Kimi delivery failure is logged but non-fatal)
  const criticalFail =
    criticalBlocked.length > 0 ||
    report.summary.healthyServices < Math.max(1, report.summary.totalServices - 2) ||
    (post_boot && post_boot.allowlisted_active === false);
  process.exit(criticalFail ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
