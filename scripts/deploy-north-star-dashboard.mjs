#!/usr/bin/env node
/**
 * Deploy Diamondnode North Star MRR Axiom dashboard.
 *
 * Default: assemble deferred Note panels (Compute or Defer) from skill scripts
 * and create/update the dashboard when credentials are present.
 *
 * Flags:
 *   --promote-apl   Build Statistic/TimeSeries/Table charts from intended APL
 *                   in dashboard-spec/north-star-mrr.apl.json (only after
 *                   getschema validates fields — do not guess in prod).
 *   --dry-run       Assemble + validate only; never call Axiom API.
 *   --print-path    Print assembled dashboard path and exit after validate.
 *
 * Credentials (first match wins):
 *   1. process.env.AXIOM_TOKEN + AXIOM_ORG_ID
 *   2. vault secrets AXIOM_TOKEN / AXIOM_ORG_ID (via vault-apply-axiom)
 *   3. ~/.axiom.toml or repo .axiom.toml [deployments.prod] non-placeholder
 *
 * Usage:
 *   node scripts/deploy-north-star-dashboard.mjs
 *   node scripts/deploy-north-star-dashboard.mjs --dry-run
 *   node scripts/deploy-north-star-dashboard.mjs --promote-apl
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = join(ROOT, "dashboard-spec");
const APL_CATALOG = join(SPEC_DIR, "north-star-mrr.apl.json");
const OUT_DASHBOARD = join(SPEC_DIR, "north-star-mrr.dashboard.json");
const SKILL_SCRIPTS =
  process.env.AXIOM_DASHBOARD_SCRIPTS ||
  "/root/.grok/installed-plugins/skills-bad470de/skills/building-dashboards/scripts";

const args = new Set(process.argv.slice(2));
const PROMOTE = args.has("--promote-apl");
const DRY = args.has("--dry-run");
const PRINT_PATH = args.has("--print-path");

function sh(cmd, opts = {}) {
  return execFileSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...opts,
  });
}

function readTomlToken(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const token = text.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  const org = text.match(/^\s*org_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!token || !org) return null;
  if (token.startsWith("REPLACE_") || org.startsWith("REPLACE_")) return null;
  if (token === "REPLACE_WITH_VAULT_AXIOM_TOKEN") return null;
  return { token, org, source: path };
}

function tryVaultApply() {
  const vaultApply = "/root/.vault/bin/vault-apply-axiom";
  const tokenFile = "/root/.vault/secrets/AXIOM_TOKEN";
  const orgFile = "/root/.vault/secrets/AXIOM_ORG_ID";
  if (!existsSync(tokenFile) || !existsSync(orgFile)) return null;
  if (!existsSync(vaultApply)) return null;
  try {
    sh(vaultApply, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    /* apply may still write partial — re-read toml */
  }
  return (
    readTomlToken(join(ROOT, ".axiom.toml")) ||
    readTomlToken(`${process.env.HOME || "/root"}/.axiom.toml`)
  );
}

function resolveCredentials() {
  if (process.env.AXIOM_TOKEN && process.env.AXIOM_ORG_ID) {
    return {
      token: process.env.AXIOM_TOKEN,
      org: process.env.AXIOM_ORG_ID,
      source: "env",
    };
  }
  const fromVault = tryVaultApply();
  if (fromVault) return fromVault;
  return (
    readTomlToken(join(ROOT, ".axiom.toml")) ||
    readTomlToken(`${process.env.HOME || "/root"}/.axiom.toml`) ||
    null
  );
}

function chartAdd(argsList, outFile) {
  const bin = join(SKILL_SCRIPTS, "chart-add");
  const r = spawnSync(bin, argsList, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`chart-add failed: ${r.stderr || r.stdout}`);
  }
  writeFileSync(outFile, r.stdout);
}

function deferNote(id, name, reason, original, unblock, outFile) {
  const text = [
    `**Deferred — blocked by:** ${reason}.`,
    "",
    `**Original spec:** ${original}.`,
    "",
    `**To unblock:** ${unblock}.`,
  ].join("\n");
  chartAdd(
    ["--type", "Note", "--id", id, "--name", name, "--text", text],
    outFile
  );
}

function buildDeferred(work) {
  const reason =
    "ops-maintenance schema not discovered (no live getschema) and/or scorecard events not ingested";
  const unblock =
    "vault-set AXIOM_TOKEN + AXIOM_ORG_ID → vault-apply-axiom; create dataset; ingest goal-scorecard/cycle; getschema; re-run with --promote-apl";

  const intro = join(work, "c-intro.json");
  chartAdd(
    [
      "--type",
      "Note",
      "--id",
      "intro",
      "--name",
      "North Star",
      "--text",
      [
        "# Diamondnode North Star — 13 × $70k MRR",
        "",
        "**Audience:** Lead AI Systems Architect / founder",
        "**Decisions:** (1) which stream to actuate next (2) whether cash path is live",
        "",
        "Local truth until Axiom ingest: `reports/goal-scorecard-latest.json`, `reports/r01-go-live.json`, `reports/cycle-latest.json`.",
        "",
        "KPI panels below are **deferred Notes** (skill: Compute or Defer). Intended APL: `dashboard-spec/north-star-mrr.apl.json`.",
      ].join("\n"),
    ],
    intro
  );

  const panels = [
    [
      "total-mrr",
      "Total MRR (USD)",
      "Statistic: latest total_mrr_usd (USD). Decision: cash path progress?",
    ],
    [
      "streams-at-floor",
      "Streams at floor (/13)",
      "Statistic: latest streams_at_floor 0–13. Decision: which streams need actuation?",
    ],
    [
      "r01-estimated-mrr",
      "R01 estimated MRR",
      "Statistic: R01 estimated_mrr USD. Decision: is inference monetizing?",
    ],
    [
      "ptv-crystal",
      "PTV crystal score",
      "Statistic: crystal_value 0–1. Decision: intrinsic loop healthy?",
    ],
    [
      "go-live-blockers",
      "R01 go-live blockers count",
      "Statistic: go_live_blockers_count. Decision: cash path live?",
    ],
    [
      "ops-cycle-health",
      "Ops cycle health",
      "Statistic: % cycles with verification_ok. Decision: trust actuation loop?",
    ],
    [
      "mrr-trend",
      "Total MRR trend",
      "TimeSeries: total_mrr_usd by bin_auto(_time). Decision: trajectory to $910k?",
    ],
    [
      "stream-mrr-table",
      "MRR by stream (R01–R13)",
      "Table: per-stream MRR. Decision: which stream to actuate next?",
    ],
    [
      "blockers-evidence",
      "Go-live blocker evidence",
      "Table: raw go_live_blockers. Decision: what to clear for cash?",
    ],
  ];

  const chartFiles = [intro];
  for (const [id, name, orig] of panels) {
    const f = join(work, `c-${id}.json`);
    deferNote(id, name, reason, orig, unblock, f);
    chartFiles.push(f);
  }
  return chartFiles;
}

function buildPromoted(work) {
  if (!existsSync(APL_CATALOG)) {
    throw new Error(`missing ${APL_CATALOG}`);
  }
  const catalog = JSON.parse(readFileSync(APL_CATALOG, "utf8"));
  const q = catalog.intended_queries || {};
  const chartFiles = [];

  const intro = join(work, "c-intro.json");
  chartAdd(
    [
      "--type",
      "Note",
      "--id",
      "intro",
      "--name",
      "North Star",
      "--text",
      "# Diamondnode North Star — 13 × $70k MRR\n\n**Promoted APL mode.** Validate panels against live data; if a field is missing, revert that panel to a deferred Note.",
    ],
    intro
  );
  chartFiles.push(intro);

  const specs = [
    ["total-mrr", "Total MRR (USD)", "Statistic", "USD"],
    ["streams-at-floor", "Streams at floor (/13)", "Statistic", null],
    ["r01-estimated-mrr", "R01 estimated MRR", "Statistic", "USD"],
    ["ptv-crystal", "PTV crystal score", "Statistic", null],
    ["go-live-blockers", "R01 go-live blockers count", "Statistic", null],
    ["ops-cycle-health", "Ops cycle health", "Statistic", "%"],
    ["mrr-trend", "Total MRR trend", "TimeSeries", "USD"],
    ["stream-mrr-table", "MRR by stream (R01–R13)", "Table", null],
    ["blockers-evidence", "Go-live blocker evidence", "Table", null],
  ];

  for (const [id, name, type, unit] of specs) {
    const entry = q[id];
    if (!entry?.apl) {
      throw new Error(`intended_queries.${id} missing apl`);
    }
    const f = join(work, `c-${id}.json`);
    const argsList = [
      "--type",
      type,
      "--id",
      id,
      "--name",
      name,
      "--apl",
      entry.apl,
    ];
    if (unit) argsList.push("--unit", unit);
    if (type === "Statistic") argsList.push("--show-chart");
    chartAdd(argsList, f);
    chartFiles.push(f);
  }
  return chartFiles;
}

function assemble(chartFiles, work) {
  const layoutFile = join(work, "layout.json");
  const layoutArgs = [
    "intro:12x3",
    "total-mrr:4x3",
    "streams-at-floor:4x3",
    "r01-estimated-mrr:4x3",
    "ptv-crystal:4x3",
    "go-live-blockers:4x3",
    "ops-cycle-health:4x3",
    "mrr-trend:6x4",
    "stream-mrr-table:6x5",
    "blockers-evidence:12x5",
  ];
  // When deferred, keep Note heights compact
  if (!PROMOTE) {
    layoutArgs[7] = "mrr-trend:6x3";
    layoutArgs[8] = "stream-mrr-table:6x3";
    layoutArgs[9] = "blockers-evidence:12x3";
  }
  const layoutBin = join(SKILL_SCRIPTS, "layout-pack");
  const layoutOut = spawnSync(layoutBin, layoutArgs, { encoding: "utf8" });
  if (layoutOut.status !== 0) {
    throw new Error(`layout-pack failed: ${layoutOut.stderr || layoutOut.stdout}`);
  }
  writeFileSync(layoutFile, layoutOut.stdout);

  const dashFile = join(work, "dashboard.json");
  const assembleBin = join(SKILL_SCRIPTS, "dashboard-assemble");
  const assembleArgs = [
    "--name",
    "Diamondnode North Star MRR",
    "--datasets",
    "ops-maintenance,ops-revenue",
    "--description",
    "13 streams × $70k MRR floor, procedural truth, R01 inference cash path. Exec/founder board.",
    "--time-window",
    "7d",
    "--refresh",
    "team",
    "--layout",
    layoutFile,
    ...chartFiles,
  ];
  const assembled = spawnSync(assembleBin, assembleArgs, { encoding: "utf8" });
  if (assembled.status !== 0) {
    throw new Error(
      `dashboard-assemble failed: ${assembled.stderr || assembled.stdout}`
    );
  }
  writeFileSync(dashFile, assembled.stdout);

  const validateBin = join(SKILL_SCRIPTS, "dashboard-validate");
  const v = spawnSync(validateBin, [dashFile, "--strict"], { encoding: "utf8" });
  process.stderr.write(v.stdout || "");
  process.stderr.write(v.stderr || "");
  if (v.status !== 0) {
    throw new Error("dashboard-validate failed");
  }

  mkdirSync(SPEC_DIR, { recursive: true });
  copyFileSync(dashFile, OUT_DASHBOARD);
  return dashFile;
}

function listExistingDashboards(deploy = "prod") {
  const bin = join(SKILL_SCRIPTS, "dashboard-list");
  try {
    const out = execFileSync(bin, [deploy], { encoding: "utf8" });
    return out;
  } catch (e) {
    return e.stdout || e.message || String(e);
  }
}

function findDashboardUid(listOutput, name) {
  try {
    const data = JSON.parse(listOutput);
    const rows = Array.isArray(data) ? data : data.dashboards || data;
    if (!Array.isArray(rows)) return null;
    const hit = rows.find((d) => d.name === name || d.dashboard?.name === name);
    return hit?.uid || hit?.id || hit?.dashboard?.uid || null;
  } catch {
    // try line-oriented
    const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    for (const line of listOutput.split("\n")) {
      if (re.test(line) && /[0-9a-zA-Z_-]{6,}/.test(line)) {
        const m = line.match(/\b([0-9a-zA-Z_-]{8,})\b/);
        if (m) return m[1];
      }
    }
    return null;
  }
}

function deploy(dashFile, creds) {
  // Ensure skill scripts see a real ~/.axiom.toml
  if (creds.source === "env") {
    const toml = [
      "[deployments.prod]",
      'url = "https://api.axiom.co"',
      `token = "${creds.token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      `org_id = "${creds.org.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      "",
    ].join("\n");
    writeFileSync(`${process.env.HOME || "/root"}/.axiom.toml`, toml, {
      mode: 0o600,
    });
    writeFileSync(join(ROOT, ".axiom.toml"), toml, { mode: 0o600 });
  }

  const listOut = listExistingDashboards("prod");
  const uid = findDashboardUid(listOut, "Diamondnode North Star MRR");

  if (uid) {
    const updateBin = join(SKILL_SCRIPTS, "dashboard-update");
    const out = execFileSync(updateBin, ["prod", uid, dashFile], {
      encoding: "utf8",
    });
    return { action: "update", uid, out };
  }

  const createBin = join(SKILL_SCRIPTS, "dashboard-create");
  const out = execFileSync(createBin, ["prod", dashFile], {
    encoding: "utf8",
  });
  const newUid = out.trim().split("\n").filter(Boolean).pop();
  let link = null;
  try {
    link = execFileSync(join(SKILL_SCRIPTS, "dashboard-link"), ["prod", newUid], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* optional */
  }
  return { action: "create", uid: newUid, link, out };
}

function main() {
  if (!existsSync(join(SKILL_SCRIPTS, "chart-add"))) {
    console.error(
      JSON.stringify({
        ok: false,
        deploy: "blocked",
        reason: `Axiom dashboard skill scripts missing at ${SKILL_SCRIPTS}`,
      })
    );
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), "north-star-dash-"));
  const chartFiles = PROMOTE ? buildPromoted(work) : buildDeferred(work);
  const dashFile = assemble(chartFiles, work);

  const result = {
    ok: true,
    mode: PROMOTE ? "promote-apl" : "deferred_notes",
    dashboard_path: OUT_DASHBOARD,
    work_charts: readdirSync(work).length,
    dry_run: DRY,
  };

  if (PRINT_PATH) {
    console.log(OUT_DASHBOARD);
    return;
  }

  if (DRY) {
    result.deploy = "skipped";
    result.reason = "--dry-run";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const creds = resolveCredentials();
  if (!creds) {
    result.ok = false;
    result.deploy = "blocked";
    result.reason =
      "No Axiom credentials: set AXIOM_TOKEN + AXIOM_ORG_ID (env or vault-set), then vault-apply-axiom. Assembled deferred dashboard written for offline review.";
    result.unblock = [
      "echo -n 'xaat-…' | vault-set AXIOM_TOKEN",
      "echo -n 'org-id' | vault-set AXIOM_ORG_ID",
      "vault-apply-axiom",
      "node scripts/deploy-north-star-dashboard.mjs",
    ];
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  try {
    const dep = deploy(dashFile, creds);
    result.deploy = "ok";
    result.action = dep.action;
    result.uid = dep.uid;
    result.link = dep.link || null;
    result.cred_source = creds.source;
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    result.ok = false;
    result.deploy = "blocked";
    result.reason = e instanceof Error ? e.message : String(e);
    result.cred_source = creds.source;
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main();
