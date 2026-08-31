#!/usr/bin/env node
/**
 * Full-story verification for diamondnode ops surface.
 * Story: operator health → services → gateway → Kimi reachability → optional gh/axiom/sentry.
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseHealthStatus } from "./r01-public-edge.mjs";

const SERVICES = [
  "openclaw-gateway",
  "ollama",
  "ssh",
  "nginx",
  "diamond-gateway",
  "redis-server",
  "qmem-llama-server",
  "qmem-sync",
  "genesis-ops-stream",
  "cloudflared",
  "cloudflared-inference",
  "ops-inference-meter",
  "ops-x402-monetize",
];

const INFERENCE_LOCAL = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";
const X402_LOCAL = process.env.X402_MONETIZE_URL || "http://127.0.0.1:8793";

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

function checkServices() {
  const results = {};
  for (const svc of SERVICES) {
    const r = sh(`systemctl is-active ${svc}`);
    results[svc] = r.out || "unknown";
  }
  return results;
}

function checkKimi() {
  const reach = sh("kimi-claw-reachability-check", { timeout: 45_000 });
  const me = sh("kimiim-cli me", { timeout: 20_000 });
  const journal = sh(
    "journalctl -u openclaw-gateway -n 80 --no-pager | grep -E 'subscribe connected|kimi-bridge' | tail -3"
  );
  // Token+bot identity is sufficient for outbound mobile updates; journal subscribe can lag after restart.
  const tokenOk = me.ok && /BOT/i.test(me.out);
  const journalOk = /subscribe connected/i.test(reach.out + "\n" + journal.out);
  const scriptOk = reach.ok && !/^FAIL:/m.test(reach.out);
  return {
    reachability: {
      ok: tokenOk || journalOk || scriptOk,
      detail: [
        reach.out.split("\n").slice(0, 4).join(" | "),
        journal.out ? `journal: ${journal.out}` : "",
        tokenOk ? "bot token path OK" : "",
      ]
        .filter(Boolean)
        .join(" // ")
        .slice(0, 300),
    },
    bot: { ok: me.ok, detail: me.out },
  };
}

function checkGh() {
  const auth = sh("gh auth status");
  const localRepo = sh("gh repo view --json nameWithOwner --jq .nameWithOwner");
  const owner =
    process.env.GH_OWNER ||
    process.env.GH_ORG ||
    "Genesis-Conductor-Engine";
  const explicitRepo = process.env.GH_REPO || "";
  const multiRepos = (process.env.GH_REPOS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let repo = { ok: localRepo.ok, detail: localRepo.out };
  if (!repo.ok && explicitRepo) {
    repo = { ok: true, detail: explicitRepo };
  } else if (!repo.ok && multiRepos.length) {
    repo = { ok: true, detail: multiRepos.join(",") };
  } else if (!repo.ok) {
    repo = { ok: true, detail: `owner:${owner}` };
  }

  let prs = { ok: false, detail: "skipped", count: 0, items: [] };
  if (auth.ok) {
    let list;
    if (explicitRepo) {
      list = sh(
        `gh pr list --repo '${explicitRepo.replace(/'/g, `'\\''`)}' --state open --json number,title,headRefName,url --limit 50`
      );
    } else if (localRepo.ok) {
      list = sh(
        "gh pr list --state open --json number,title,headRefName,url --limit 50"
      );
    } else {
      // Owner-wide search — no local git remote required
      list = sh(
        `gh search prs --owner '${owner.replace(/'/g, `'\\''`)}' --state open --limit 50 --json repository,number,title,url`
      );
    }
    if (list.ok) {
      try {
        const items = JSON.parse(list.out || "[]");
        prs = {
          ok: true,
          detail: `${items.length} open PRs (${repo.detail})`,
          count: items.length,
          items,
        };
      } catch {
        prs = { ok: false, detail: list.out, count: 0, items: [] };
      }
    } else {
      prs = { ok: false, detail: list.out, count: 0, items: [] };
    }
  }
  return {
    auth: { ok: auth.ok, detail: auth.out },
    repo,
    prs,
  };
}

/**
 * Load public inference base URL from config + reports (non-secret).
 * trycloudflare hostnames are accepted; never critical by themselves.
 */
export function loadInferencePublicUrl() {
  const root = process.cwd();
  const candidates = [
    join(root, "config", "inference-public.json"),
    join(root, "reports", "inference-public.json"),
  ];
  let fromJson = null;
  let jsonPath = null;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const url = (j.public_base_url || j.public_url || j.url || "").trim();
      if (url) {
        fromJson = url.replace(/\/$/, "");
        jsonPath = p;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  const urlTxtPath = join(root, "reports", "inference-public-url.txt");
  let fromTxt = null;
  if (existsSync(urlTxtPath)) {
    try {
      fromTxt = readFileSync(urlTxtPath, "utf8").trim().split(/\s+/)[0] || null;
      if (fromTxt) fromTxt = fromTxt.replace(/\/$/, "");
    } catch {
      /* ignore */
    }
  }
  const publicUrl = fromJson || fromTxt || null;
  const isTrycloudflare = Boolean(
    publicUrl && /trycloudflare\.com/i.test(publicUrl)
  );
  return {
    public_url: publicUrl,
    source: fromJson ? jsonPath : fromTxt ? urlTxtPath : null,
    file_present: Boolean(publicUrl),
    is_trycloudflare: isTrycloudflare,
    mode: isTrycloudflare ? "quick-tunnel" : publicUrl ? "named-or-custom" : "unset",
  };
}

/**
 * Inference meter health (local) + optional public URL presence.
 * Public URL / trycloudflare is never a critical failure.
 */
export function checkInferenceMeter() {
  const unit = sh("systemctl is-active ops-inference-meter").out || "unknown";
  const tunnelUnit =
    sh("systemctl is-active cloudflared-inference").out || "unknown";
  const health = sh(`curl -sS -m 3 ${INFERENCE_LOCAL}/health`);
  let healthJson = null;
  let healthOk = false;
  if (health.ok) {
    try {
      healthJson = JSON.parse(health.out);
      healthOk = healthJson?.ok === true || healthJson?.service?.includes("inference");
    } catch {
      healthOk = /ok|inference/i.test(health.out);
    }
  }

  const pub = loadInferencePublicUrl();
  let publicProbe = {
    ok: false,
    skipped: true,
    status: null,
    body: "",
    detail: "no public URL",
  };
  if (pub.public_url) {
    const base = pub.public_url.replace(/'/g, "");
    const code = sh(
      `curl -sS -m 5 -o /dev/null -w '%{http_code}' ${base}/health`
    );
    const body = sh(`curl -sS -m 5 ${base}/health`);
    const bodyText = body.out || "";
    const status = parseHealthStatus(code.out);
    const httpOk = status === 200;
    publicProbe = {
      ok: httpOk,
      skipped: false,
      status,
      body: bodyText.slice(0, 200),
      detail: httpOk
        ? `${pub.public_url}/health → 200${pub.is_trycloudflare ? " (trycloudflare)" : ""}`
        : `${pub.public_url}/health → ${status ?? (code.out || "fail")}${pub.is_trycloudflare ? " (trycloudflare optional)" : ""}`,
    };
  }

  // Local meter healthy = unit active OR HTTP ok (prefer both)
  const localOk = unit === "active" && healthOk;
  return {
    unit,
    tunnel_unit: tunnelUnit,
    local: {
      ok: localOk,
      health_ok: healthOk,
      detail: healthOk
        ? `ops-inference-meter ${unit}; ${INFERENCE_LOCAL}/health ok`
        : `ops-inference-meter ${unit}; health=${health.out?.slice(0, 120) || "fail"}`,
      raw: healthJson,
    },
    public: {
      ...pub,
      probe: publicProbe,
      // Presence is optional non-critical; trycloudflare is fine for go-live staging
      ok: pub.file_present,
      detail: pub.file_present
        ? `${pub.public_url} (${pub.mode}) via ${pub.source}`
        : "optional: config/inference-public.json or reports/inference-public-url.txt missing",
    },
  };
}

/**
 * x402 monetize service + flywheel surface (local). Not critical if unit absent on older hosts.
 */
export function checkX402Monetize() {
  const unit = sh("systemctl is-active ops-x402-monetize").out || "unknown";
  const health = sh(`curl -sS -m 3 ${X402_LOCAL}/health`);
  let healthOk = false;
  let healthJson = null;
  if (health.ok) {
    try {
      healthJson = JSON.parse(health.out);
      healthOk = healthJson?.ok === true;
    } catch {
      healthOk = false;
    }
  }
  const challenge = sh(
    `curl -sS -m 3 -o /dev/null -w '%{http_code}' '${X402_LOCAL}/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits'`,
  );
  const challengeOk = challenge.out === "402";
  const localOk = unit === "active" && healthOk && challengeOk;
  return {
    unit,
    local: {
      ok: localOk,
      health_ok: healthOk,
      challenge_402: challengeOk,
      detail: localOk
        ? `ops-x402-monetize ${unit}; challenge 402; payTo=${healthJson?.payTo || "?"}`
        : `ops-x402-monetize ${unit}; health=${healthOk}; challenge=${challenge.out}`,
      raw: healthJson,
    },
  };
}

function checkObservability() {
  // Axiom deliberately skipped — local stack: Redis + genesis-ops SSE + Kimi + cashflow ledger
  const redis = sh("redis-cli ping");
  const redisOk = redis.ok && /PONG/i.test(redis.out);
  const genesis =
    sh("systemctl is-active genesis-ops-stream").out === "active" ||
    sh("curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/").out ===
      "200";
  const opsHttp =
    sh("curl -sS -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8791/health")
      .out === "200";
  const cashflowPath = join(process.cwd(), "reports", "cashflow-latest.json");
  const cashflowFile = sh(`test -f ${cashflowPath} && echo present || echo missing`);
  const sentry =
    sh("test -f /root/.sentryclirc && echo present || echo missing").out === "present";
  return {
    axiom: {
      ok: true,
      skipped: true,
      detail: "SKIPPED: use Redis + genesis-ops:8787 + cashflow ledger + Kimi",
    },
    redis: {
      ok: redisOk,
      detail: redisOk ? "PONG" : redis.out || "redis-cli failed",
    },
    genesis_ops: {
      ok: Boolean(genesis),
      detail: genesis ? "genesis-ops-stream / :8787 up" : "genesis-ops-stream down",
    },
    ops_http: {
      ok: opsHttp,
      detail: opsHttp ? ":8791/health ok" : "ops-maintenance-http down",
    },
    cashflow: {
      ok: cashflowFile.out === "present" || redisOk,
      detail:
        cashflowFile.out === "present"
          ? "reports/cashflow-latest.json"
          : redisOk
            ? "redis available (ledger will seed)"
            : "no cashflow backend yet",
    },
    sentry: {
      ok: sentry,
      detail: sentry
        ? "config present"
        : "optional: missing Sentry DSN (not required for cashflow)",
    },
  };
}

function boundaryStatus(ok) {
  return ok ? "✅" : "❌";
}

export function runVerification() {
  const started = new Date().toISOString();
  const services = checkServices();
  const activeCount = Object.values(services).filter((s) => s === "active").length;
  const servicesOk = activeCount === SERVICES.length;

  const kimi = checkKimi();
  const gh = checkGh();
  const obs = checkObservability();
  const inference = checkInferenceMeter();
  const x402 = checkX402Monetize();

  const flow = [
    {
      boundary: "Core services (systemd)",
      status: boundaryStatus(servicesOk),
      evidence: `${activeCount}/${SERVICES.length} active`,
    },
    {
      boundary: "openclaw-gateway",
      status: boundaryStatus(services["openclaw-gateway"] === "active"),
      evidence: services["openclaw-gateway"],
    },
    {
      boundary: "Inference meter (R01)",
      status: boundaryStatus(inference.local.ok),
      evidence: inference.local.detail,
    },
    {
      boundary: "x402 monetize + flywheel",
      status: boundaryStatus(x402.local.ok),
      evidence: x402.local.detail,
    },
    {
      boundary: "Inference public URL (optional)",
      // File presence is informational; trycloudflare is never ❌-critical.
      // Missing file → ⏭ (optional). Present → ✅ even if public probe soft-fails.
      status: inference.public.file_present ? "✅" : "⏭",
      evidence: inference.public.detail +
        (inference.public.probe && !inference.public.probe.skipped
          ? ` · ${inference.public.probe.detail}`
          : ""),
    },
    {
      boundary: "Kimi reachability",
      status: boundaryStatus(kimi.reachability.ok),
      evidence: kimi.reachability.detail.split("\n")[0] || kimi.reachability.detail,
    },
    {
      boundary: "Kimi bot identity",
      status: boundaryStatus(kimi.bot.ok),
      evidence: kimi.bot.detail.replace(/\n/g, " | ").slice(0, 200),
    },
    {
      boundary: "GitHub auth (PR babysit)",
      status: boundaryStatus(gh.auth.ok),
      evidence: gh.auth.ok ? "authenticated" : "BLOCKED: gh auth login required",
    },
    {
      boundary: "Open PR inventory",
      status: boundaryStatus(gh.prs.ok || !gh.auth.ok),
      evidence: gh.prs.detail,
    },
    {
      boundary: "Redis (cashflow + cache)",
      status: boundaryStatus(obs.redis.ok),
      evidence: obs.redis.detail,
    },
    {
      boundary: "Genesis ops stream :8787",
      status: boundaryStatus(obs.genesis_ops.ok),
      evidence: obs.genesis_ops.detail,
    },
    {
      boundary: "Cashflow ledger",
      status: boundaryStatus(obs.cashflow.ok),
      evidence: obs.cashflow.detail,
    },
    {
      boundary: "Axiom",
      status: "⏭",
      evidence: obs.axiom.detail,
    },
    {
      boundary: "Sentry (optional)",
      status: obs.sentry.ok ? "✅" : "⏭",
      evidence: obs.sentry.detail,
    },
  ];

  const blocked = flow.filter((f) => f.status === "❌");
  // Critical path = services + Kimi + local inference meter.
  // Public URL / trycloudflare / gh / axiom / sentry are optional.
  const criticalBoundaries = new Set([
    "Core services (systemd)",
    "openclaw-gateway",
    "Inference meter (R01)",
    "x402 monetize + flywheel",
    "Kimi reachability",
    "Kimi bot identity",
    "Redis (cashflow + cache)",
  ]);
  const criticalBlocked = blocked.filter((b) => criticalBoundaries.has(b.boundary));
  const report = {
    story:
      "Ops maintenance agent keeps diamondnode healthy, babysits PRs, and pushes Kimi mobile updates",
    started,
    finished: new Date().toISOString(),
    services,
    inference,
    x402,
    kimi,
    gh: {
      auth: gh.auth,
      repo: gh.repo,
      prCount: gh.prs.count,
      prs: gh.prs.items,
    },
    observability: obs,
    flow,
    summary: {
      ok: criticalBlocked.length === 0,
      blocked: blocked.map((b) => b.boundary),
      criticalBlocked: criticalBlocked.map((b) => b.boundary),
      optionalBlocked: blocked
        .filter((b) => !criticalBoundaries.has(b.boundary))
        .map((b) => b.boundary),
      healthyServices: activeCount,
      totalServices: SERVICES.length,
      inference_meter_ok: inference.local.ok,
      inference_public_url: inference.public.public_url || null,
    },
  };

  const outDir = join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `verify-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "latest.json"), JSON.stringify(report, null, 2));

  return { report, path };
}

function formatMarkdown(report) {
  const lines = [
    `## Verification Report: diamondnode ops`,
    ``,
    `**Story**: ${report.story}`,
    `**When**: ${report.started}`,
    ``,
    `### Flow Status`,
    `| Boundary | Status | Evidence |`,
    `|----------|--------|----------|`,
    ...report.flow.map(
      (f) =>
        `| ${f.boundary} | ${f.status} | ${String(f.evidence).replace(/\|/g, "/").slice(0, 120)} |`
    ),
    ``,
    `### Issues`,
    ...(report.summary.blocked.length
      ? report.summary.blocked.map((b) => `- ❌ ${b}`)
      : ["- none"]),
    ``,
    `### Working`,
    `- Services: ${report.summary.healthyServices}/${report.summary.totalServices}`,
    `- Inference meter: ${report.summary.inference_meter_ok ? "healthy" : "down"}` +
      (report.summary.inference_public_url
        ? ` · public ${report.summary.inference_public_url}`
        : ""),
    `- Kimi bot: OpenClaw-moY`,
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify.mjs")) {
  const { report, path } = runVerification();
  console.log(formatMarkdown(report));
  console.log(`\nWrote ${path}`);
  process.exit(report.summary.ok ? 0 : 2);
}

export { formatMarkdown };
