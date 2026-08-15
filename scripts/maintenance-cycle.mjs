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
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  runVerification,
  formatMarkdown,
  loadInferencePublicUrl,
  checkInferenceMeter,
} from "./verify.mjs";
import {
  buildR01Readiness,
  buildPublicEdgeBlockers,
} from "./r01-public-edge.mjs";
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

function readVaultSecret(name) {
  const paths = [
    join("/root/.vault/secrets", name),
    join(process.cwd(), ".vault", "secrets", name),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      /* ignore */
    }
  }
  // agent.env KEY=value (never log value)
  const envFile = "/root/.vault/env/agent.env";
  if (existsSync(envFile)) {
    try {
      const lines = readFileSync(envFile, "utf8").split("\n");
      for (const line of lines) {
        const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
        if (m) {
          return m[1].trim().replace(/^['"]|['"]$/g, "");
        }
      }
    } catch {
      /* ignore */
    }
  }
  return process.env[name] || "";
}

/**
 * Snapshot R01 inference revenue + public URL for cycle summary / go-live.
 * Never logs raw API keys or webhook secrets.
 */
function snapshotInferenceRevenue() {
  const meterUrl = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";
  const pub = loadInferencePublicUrl();
  const health = sh(`curl -sS -m 3 ${meterUrl}/health`);
  let healthOk = false;
  let healthBody = null;
  if (health.ok) {
    try {
      healthBody = JSON.parse(health.out);
      healthOk = healthBody?.ok === true;
    } catch {
      healthOk = false;
    }
  }

  const admin = readVaultSecret("INFERENCE_ADMIN_TOKEN");
  let revenue = null;
  if (admin) {
    const rev = sh(
      `curl -sS -m 3 -H 'Authorization: Bearer ${admin.replace(/'/g, "")}' ${meterUrl}/admin/revenue`
    );
    if (rev.ok) {
      try {
        revenue = JSON.parse(rev.out);
      } catch {
        revenue = null;
      }
    }
  }

  // Fall back to local keys file estimated MRR if admin unavailable
  if (!revenue) {
    const keysPath = join(process.cwd(), "reports", "inference-keys.json");
    if (existsSync(keysPath)) {
      try {
        const store = JSON.parse(readFileSync(keysPath, "utf8"));
        const keys = Object.values(store.keys || {});
        const tierPrice = { free: 0, starter: 29, pro: 149, enterprise: 999 };
        let mrr = 0;
        const byTier = {};
        let active = 0;
        for (const k of keys) {
          if (!k.active) continue;
          active += 1;
          mrr += tierPrice[k.tier] ?? 0;
          byTier[k.tier] = (byTier[k.tier] || 0) + 1;
        }
        revenue = {
          active_keys: active,
          by_tier: byTier,
          estimated_mrr_usd: mrr,
          stream: "R01",
          source: "disk-fallback",
        };
      } catch {
        /* ignore */
      }
    }
  }

  const webhookSecretPresent = Boolean(
    readVaultSecret("STRIPE_WEBHOOK_SECRET") || process.env.STRIPE_WEBHOOK_SECRET
  );
  const checkoutStarter = Boolean(
    readVaultSecret("STRIPE_CHECKOUT_STARTER_URL") ||
      process.env.STRIPE_CHECKOUT_STARTER_URL
  );
  const checkoutPro = Boolean(
    readVaultSecret("STRIPE_CHECKOUT_PRO_URL") || process.env.STRIPE_CHECKOUT_PRO_URL
  );
  const checkoutEnterprise = Boolean(
    readVaultSecret("STRIPE_CHECKOUT_ENTERPRISE_URL") ||
      process.env.STRIPE_CHECKOUT_ENTERPRISE_URL
  );

  const publicBase = pub.public_url || "https://inference.yennefer.quest";
  const webhookEndpoint = `${publicBase.replace(/\/$/, "")}/webhook/stripe`;

  return {
    stream: "R01",
    meter_health_ok: healthOk,
    estimated_mrr: revenue?.estimated_mrr_usd ?? 0,
    active_keys: revenue?.active_keys ?? 0,
    by_tier: revenue?.by_tier || {},
    usage_today: revenue?.usage_today || null,
    public_url: pub.public_url,
    public_url_mode: pub.mode,
    public_url_file_present: pub.file_present,
    is_trycloudflare: pub.is_trycloudflare,
    webhook_endpoint: webhookEndpoint,
    stripe_webhook_secret: webhookSecretPresent,
    stripe_checkout_urls: {
      starter: checkoutStarter,
      pro: checkoutPro,
      enterprise: checkoutEnterprise,
    },
    revenue_source: revenue?.source || (revenue ? "admin/revenue" : null),
  };
}

function writeR01GoLive(inference, verificationReport) {
  const outDir = join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const meter = verificationReport?.inference || checkInferenceMeter();
  const probe = meter?.public?.probe || {};
  const tunnelUnitActive =
    meter?.tunnel_unit === "active" || isUnitActive("cloudflared-inference");
  const edgeReadiness = buildR01Readiness({
    publicUrl: inference.public_url,
    mode: inference.public_url_mode,
    healthStatus: probe.status ?? (probe.ok === true ? 200 : null),
    healthBody: probe.body || probe.detail || "",
    tunnelUnitActive,
    registeredConnections: meter?.tunnel_registered_connections,
  });
  const snap = {
    stream: "R01",
    product: "Metered Sovereign LLM API",
    at: new Date().toISOString(),
    readiness: {
      meter_local_ok: Boolean(inference.meter_health_ok),
      meter_unit_active: meter?.unit === "active" || isUnitActive("ops-inference-meter"),
      tunnel_unit_active: tunnelUnitActive,
      public_url_present: Boolean(inference.public_url),
      public_url_mode: inference.public_url_mode || null,
      is_trycloudflare: Boolean(inference.is_trycloudflare),
      public_edge_ok: edgeReadiness.public_edge_ok,
      public_edge_reason: edgeReadiness.public_edge_reason,
      public_health_status: edgeReadiness.public_health_status,
      tunnel_control_plane_ok: edgeReadiness.tunnel_control_plane_ok,
      tunnel_control_plane_reason: edgeReadiness.tunnel_control_plane_reason,
      stripe_webhook_secret: Boolean(inference.stripe_webhook_secret),
      stripe_checkout_urls_any: Object.values(
        inference.stripe_checkout_urls || {}
      ).some(Boolean),
      verification_ok: Boolean(verificationReport?.summary?.ok),
    },
    revenue: {
      estimated_mrr: inference.estimated_mrr,
      active_keys: inference.active_keys,
      by_tier: inference.by_tier,
    },
    endpoints: {
      public_base_url: inference.public_url,
      health: inference.public_url
        ? `${inference.public_url.replace(/\/$/, "")}/health`
        : null,
      pricing: inference.public_url
        ? `${inference.public_url.replace(/\/$/, "")}/pricing`
        : null,
      chat_completions: inference.public_url
        ? `${inference.public_url.replace(/\/$/, "")}/v1/chat/completions`
        : null,
      webhook_stripe: inference.webhook_endpoint,
      issued_key: inference.public_url
        ? `${inference.public_url.replace(/\/$/, "")}/issued-key?session_id=`
        : null,
      admin_revenue_localhost: "http://127.0.0.1:8792/admin/revenue",
    },
    go_live_blockers: [
      !inference.meter_health_ok && "inference meter health down",
      !inference.stripe_webhook_secret &&
        "STRIPE_WEBHOOK_SECRET missing in vault (webhook returns 503 until set)",
      !Object.values(inference.stripe_checkout_urls || {}).some(Boolean) &&
        "Stripe checkout Payment Links not set (optional until Dashboard products exist)",
      ...buildPublicEdgeBlockers(edgeReadiness),
    ].filter(Boolean),
    notes: [
      "Admin revenue/keys endpoints are localhost-only (public /admin → 404).",
      "Configure Stripe Dashboard webhook → endpoints.webhook_stripe with checkout.session.completed.",
      "trycloudflare public URL is non-critical for verification; prefer named tunnel for cash.",
    ],
  };
  const path = join(outDir, "r01-go-live.json");
  writeFileSync(path, JSON.stringify(snap, null, 2));
  return { path, snap };
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

  console.log("[cycle] inference revenue (R01)…");
  let inference = null;
  let inference_brief = "";
  let r01_go_live = null;
  try {
    inference = snapshotInferenceRevenue();
    inference_brief =
      `R01 inference: mrr≈$${inference.estimated_mrr} keys=${inference.active_keys}` +
      ` url=${inference.public_url || "unset"}` +
      ` webhook=${inference.stripe_webhook_secret ? "secret-set" : "secret-MISSING"}` +
      (inference.is_trycloudflare ? " (trycloudflare)" : "");
    console.log(`[cycle] ${inference_brief}`);
    console.log(
      `[cycle] R01 webhook endpoint: ${inference.webhook_endpoint}`
    );
    const written = writeR01GoLive(inference, report);
    r01_go_live = {
      path: written.path,
      readiness: written.snap.readiness,
      go_live_blockers: written.snap.go_live_blockers,
    };
    console.log(`[cycle] wrote ${written.path}`);
  } catch (e) {
    inference = { error: String(e?.message || e) };
    console.error("[cycle] inference revenue error:", inference.error);
  }

  console.log("[cycle] cashflow ledger…");
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
    inference_brief || "R01 inference: unavailable",
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
  console.log("[cycle] procedural truth + goal scorecard…");
  let procedural_truth = null;
  let goal_scorecard = null;
  try {
    const ptvOut = sh("node scripts/procedural-truth.mjs", { timeout: 90_000 });
    if (ptvOut.ok) {
      try {
        procedural_truth = JSON.parse(ptvOut.out);
      } catch {
        procedural_truth = { raw: ptvOut.out.slice(0, 500) };
      }
    } else {
      procedural_truth = { ok: false, error: ptvOut.out.slice(0, 300) };
    }
    console.log(
      `[cycle] ptv ok=${procedural_truth?.ok} crystal=${procedural_truth?.crystal_value}`
    );
  } catch (e) {
    procedural_truth = { ok: false, error: String(e?.message || e) };
  }
  try {
    const gsOut = sh("node scripts/goal-scorecard.mjs", { timeout: 90_000 });
    const gsPath = join(process.cwd(), "reports", "goal-scorecard-latest.json");
    if (existsSync(gsPath)) {
      goal_scorecard = JSON.parse(readFileSync(gsPath, "utf8"));
    } else if (gsOut.ok) {
      try {
        goal_scorecard = JSON.parse(gsOut.out);
      } catch {
        goal_scorecard = { raw: gsOut.out.slice(0, 500) };
      }
    }
    if (goal_scorecard?.totals) {
      console.log(
        `[cycle] goal streams_at_floor=${goal_scorecard.totals.streams_at_floor}/13 mrr=$${goal_scorecard.totals.total_mrr_usd}`
      );
    }
  } catch (e) {
    goal_scorecard = { error: String(e?.message || e) };
  }

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
    inference: inference
      ? {
          estimated_mrr: inference.estimated_mrr,
          active_keys: inference.active_keys,
          public_url: inference.public_url,
          webhook_endpoint: inference.webhook_endpoint,
          stripe_webhook_secret: inference.stripe_webhook_secret,
          meter_health_ok: inference.meter_health_ok,
          by_tier: inference.by_tier,
        }
      : null,
    r01_go_live,
    cashflow: cashflow?.totals
      ? { totals: cashflow.totals, backend: cashflow.backend, updated_at: cashflow.updated_at }
      : cashflow,
    deployments,
    procedural_truth,
    goal_scorecard: goal_scorecard
      ? {
          ok: goal_scorecard.ok,
          totals: goal_scorecard.totals,
          procedural_truth: goal_scorecard.procedural_truth,
          priorities: goal_scorecard.priorities,
        }
      : null,
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
