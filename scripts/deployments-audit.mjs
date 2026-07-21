#!/usr/bin/env node
/**
 * Diamondnode-wide deployments & CI/CD audit (R10).
 * Inventory: Vercel projects, Cloudflare workers on disk, local systemd, public probes.
 * Optional live Vercel API when VERCEL_TOKEN is set.
 */
import { execSync, execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REGISTRY_PATH = join(ROOT, "config", "deploy-registry.json");
const REPORTS = join(ROOT, "reports");

function sh(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        timeout: opts.timeout ?? 20_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...opts.env },
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

function checkUnit(unit) {
  const r = sh(`systemctl is-active ${unit}`);
  return { unit, state: r.out || "unknown", active: r.out === "active" };
}

async function probeUrl(entry) {
  const expect = entry.expect_status || [200];
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(entry.url, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "user-agent": "diamondnode-deploy-audit/1.0" },
    });
    clearTimeout(t);
    const ms = Date.now() - started;
    const ok = expect.includes(res.status);
    return {
      name: entry.name,
      url: entry.url,
      status: res.status,
      ok,
      ms,
    };
  } catch (e) {
    return {
      name: entry.name,
      url: entry.url,
      status: 0,
      ok: false,
      ms: Date.now() - started,
      error: String(e?.message || e).slice(0, 200),
    };
  }
}

function scanCloudflareWorkers(workers) {
  return workers.map((w) => {
    const path = w.path;
    const hasToml =
      existsSync(join(path, "wrangler.toml")) ||
      existsSync(join(path, "wrangler.jsonc"));
    const hasPkg = existsSync(join(path, "package.json"));
    let gha = false;
    const wfDir = join(path, ".github", "workflows");
    if (existsSync(wfDir)) {
      try {
        gha = readdirSync(wfDir).some((f) => /\.ya?ml$/i.test(f));
      } catch {
        gha = false;
      }
    }
    return {
      name: w.name,
      path,
      priority: w.priority,
      streams: w.streams || [],
      on_disk: hasToml || hasPkg,
      has_wrangler: hasToml,
      has_gha: gha,
      status: w.status || (hasToml ? "present" : "missing"),
    };
  });
}

async function vercelApi(path, token) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function auditVercelProjects(projects, token) {
  const results = [];
  for (const p of projects) {
    const base = {
      id: p.id,
      name: p.name,
      teamId: p.teamId,
      repo: p.repo || null,
      priority: p.priority,
      streams: p.streams || [],
      public_url: p.public_url || null,
      cicd: p.cicd || [],
    };
    if (!token) {
      results.push({
        ...base,
        live: false,
        note: "set VERCEL_TOKEN for live deployment state",
      });
      continue;
    }
    try {
      const qs = new URLSearchParams({
        projectId: p.id,
        limit: "5",
      });
      if (p.teamId) qs.set("teamId", p.teamId);
      const data = await vercelApi(`/v6/deployments?${qs}`, token);
      const deps = data.deployments || [];
      const latest = deps[0] || null;
      const prod = deps.find((d) => d.target === "production") || null;
      results.push({
        ...base,
        live: true,
        latest: latest
          ? {
              uid: latest.uid,
              state: latest.state || latest.readyState,
              target: latest.target || null,
              url: latest.url ? `https://${latest.url}` : null,
              created: latest.created,
            }
          : null,
        production: prod
          ? {
              uid: prod.uid,
              state: prod.state || prod.readyState,
              url: prod.url ? `https://${prod.url}` : null,
              created: prod.created,
            }
          : null,
        healthy:
          (prod?.state || prod?.readyState || latest?.state) === "READY",
      });
    } catch (e) {
      results.push({
        ...base,
        live: true,
        error: String(e?.message || e).slice(0, 240),
        healthy: false,
      });
    }
  }
  return results;
}

function checkVercelCli() {
  const v = sh("vercel --version");
  return {
    installed: v.ok,
    version: v.ok ? v.out.split("\n").pop() : null,
    detail: v.out.slice(0, 120),
  };
}

function knownFailureHints(vercelProjects) {
  // Static known issues from live MCP audit (2026-07-10) when token absent
  const hints = {
    "genesis-conductor-site":
      "ERROR: npm install ERESOLVE — @opennextjs/cloudflare@latest requires next>=15.5.18 but package pins next@14. Fix: bump next or pin opennext / use .npmrc legacy-peer-deps.",
    web: "ERROR: single production deploy failed (SEAR workspace pack).",
    "yennefer-observatory":
      "Recent previews CANCELED/ERROR from .github profile repo pushes; production READY from yennefer-cortex main.",
    "lidlift-live":
      "Intermittent ERROR on dependabot/feature branches; production has READY deploys.",
  };
  return vercelProjects
    .filter((p) => hints[p.name])
    .map((p) => ({ project: p.name, hint: hints[p.name], priority: p.priority }));
}

export async function runDeploymentsAudit(opts = {}) {
  const registry = loadRegistry();
  const token = opts.token || process.env.VERCEL_TOKEN || "";

  const local_services = (registry.local_services || []).map((s) => ({
    ...checkUnit(s.unit),
    priority: s.priority,
    streams: s.streams || [],
  }));

  const cloudflare_workers = scanCloudflareWorkers(
    registry.cloudflare_workers || []
  );

  const public_probes = [];
  for (const p of registry.public_probes || []) {
    public_probes.push(await probeUrl(p));
  }

  const vercel_cli = checkVercelCli();
  const vercel_projects = await auditVercelProjects(
    registry.vercel_projects || [],
    token
  );

  const local_down = local_services.filter((s) => !s.active);
  const probes_fail = public_probes.filter((p) => !p.ok);
  const cf_missing = cloudflare_workers.filter((w) => !w.on_disk);
  const vercel_unhealthy = vercel_projects.filter(
    (p) => p.live && p.healthy === false
  );

  const failure_hints = knownFailureHints(registry.vercel_projects || []);

  const summary = {
    ok:
      local_down.length === 0 &&
      probes_fail.filter((p) => !p.name.includes("optimizationinversion"))
        .length === 0 &&
      vercel_unhealthy.length === 0,
    local_active: local_services.filter((s) => s.active).length,
    local_total: local_services.length,
    local_down: local_down.map((s) => s.unit),
    cf_on_disk: cloudflare_workers.filter((w) => w.on_disk).length,
    cf_total: cloudflare_workers.length,
    probes_ok: public_probes.filter((p) => p.ok).length,
    probes_total: public_probes.length,
    probes_fail: probes_fail.map((p) => p.name),
    vercel_live: Boolean(token),
    vercel_projects: vercel_projects.length,
    vercel_unhealthy: vercel_unhealthy.map((p) => p.name),
    p0_attention: [
      ...local_down.filter((s) =>
        (registry.local_services || []).find(
          (x) => x.unit === s.unit && x.priority === "p0"
        )
      ).map((s) => `local:${s.unit}`),
      ...failure_hints
        .filter((h) => h.priority === "p0")
        .map((h) => `vercel:${h.project}`),
    ],
  };

  const report = {
    at: new Date().toISOString(),
    host: registry.host,
    stream: registry.stream,
    vercel_cli,
    summary,
    failure_hints,
    local_services,
    cloudflare_workers,
    public_probes,
    vercel_projects,
    cicd_defaults: registry.cicd_defaults,
    teams: registry.vercel_teams,
  };

  mkdirSync(REPORTS, { recursive: true });
  const outPath = join(REPORTS, "deployments-latest.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  writeFileSync(
    join(REPORTS, `deployments-${report.at.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(report, null, 2)
  );

  return { report, outPath };
}

export function formatDeployBrief(report) {
  const s = report.summary;
  const parts = [
    `Deploy audit: local ${s.local_active}/${s.local_total}`,
    `CF workers on disk ${s.cf_on_disk}/${s.cf_total}`,
    `probes ${s.probes_ok}/${s.probes_total}`,
    s.vercel_live
      ? `vercel live unhealthy=[${s.vercel_unhealthy.join(",") || "none"}]`
      : "vercel static (no VERCEL_TOKEN)",
  ];
  if (s.p0_attention?.length) {
    parts.push(`P0: ${s.p0_attention.join(", ")}`);
  }
  if (report.failure_hints?.length) {
    parts.push(
      `hints: ${report.failure_hints.map((h) => h.project).join(", ")}`
    );
  }
  return parts.join(" | ");
}

async function main() {
  const { report, outPath } = await runDeploymentsAudit();
  console.log(JSON.stringify(report, null, 2));
  console.error(`[deployments-audit] wrote ${outPath}`);
  console.error(formatDeployBrief(report));
  process.exit(report.summary.ok ? 0 : 2);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
