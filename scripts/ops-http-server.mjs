#!/usr/bin/env node
/**
 * Lightweight local control plane for MaintenanceAgent / Workflow steps.
 * Binds 127.0.0.1:8791 by default (or OPS_HTTP_PORT).
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.OPS_HTTP_PORT || 8791);
const HOST = process.env.OPS_HTTP_HOST || "127.0.0.1";
const TOKEN = process.env.OPS_TOKEN || "";

function auth(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

function runNpmScript(name) {
  return execFileSync("node", [join(ROOT, "scripts", name)], {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
    timeout: 120_000,
  });
}

function json(res, code, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  if (!auth(req)) {
    return json(res, 401, { error: "unauthorized" });
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "ops-maintenance-http" });
    }

    if (url.pathname === "/ops/verify" && req.method === "GET") {
      runNpmScript("verify.mjs");
      const latest = join(ROOT, "reports", "latest.json");
      if (existsSync(latest)) {
        return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
      }
      return json(res, 500, { error: "no report" });
    }

    if (url.pathname === "/ops/pr-babysit" && req.method === "POST") {
      const out = runNpmScript("pr-babysit.mjs");
      try {
        return json(res, 200, JSON.parse(out));
      } catch {
        return json(res, 200, { raw: out });
      }
    }

    if (url.pathname === "/ops/kimi-update" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString("utf8");
      const out = execFileSync("node", [join(ROOT, "scripts", "kimi-update.mjs"), body], {
        encoding: "utf8",
        cwd: ROOT,
        env: process.env,
        timeout: 90_000,
      });
      return json(res, 200, { ok: true, out });
    }

    if (url.pathname === "/ops/maintenance-cycle" && req.method === "POST") {
      const out = runNpmScript("maintenance-cycle.mjs");
      return json(res, 200, { ok: true, out: out.slice(0, 8000) });
    }

    if (url.pathname === "/ops/pr-auto-action" && (req.method === "POST" || req.method === "GET")) {
      const max = Number(url.searchParams.get("max") || process.env.PR_AUTO_MAX || 24);
      const dry = url.searchParams.get("dry") === "1";
      const out = execFileSync(
        "node",
        [
          join(ROOT, "scripts", "pr-auto-actioner.mjs"),
          "--max",
          String(max),
          ...(dry ? ["--dry-run"] : []),
        ],
        {
          encoding: "utf8",
          cwd: ROOT,
          env: process.env,
          timeout: 600_000,
        }
      );
      try {
        return json(res, 200, JSON.parse(out));
      } catch {
        const latest = join(ROOT, "reports", "pr-auto-action-latest.json");
        if (existsSync(latest)) {
          return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
        }
        return json(res, 200, { raw: out.slice(0, 8000) });
      }
    }

    if (url.pathname === "/ops/pr-babysit/inventory" && req.method === "POST") {
      const out = runNpmScript("pr-babysit.mjs");
      try {
        return json(res, 200, JSON.parse(out));
      } catch {
        return json(res, 200, { raw: out.slice(0, 8000) });
      }
    }

    if (url.pathname === "/ops/cashflow" && req.method === "GET") {
      const out = runNpmScript("cashflow-ledger.mjs");
      const latest = join(ROOT, "reports", "cashflow-latest.json");
      if (existsSync(latest)) {
        return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
      }
      return json(res, 200, { raw: out });
    }

    if (url.pathname === "/ops/cashflow/record" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const id = body.stream || body.id;
      if (!id) return json(res, 400, { error: "stream id required (R01..R13)" });
      const args = [join(ROOT, "scripts", "cashflow-ledger.mjs"), "record", id];
      if (body.mrr_actual != null) args.push("--mrr", String(body.mrr_actual));
      if (body.pipeline_usd != null) args.push("--pipeline", String(body.pipeline_usd));
      if (body.cash_collected_mtd != null) args.push("--cash", String(body.cash_collected_mtd));
      if (body.delta_mrr != null) args.push("--delta-mrr", String(body.delta_mrr));
      if (body.delta_cash != null) args.push("--delta-cash", String(body.delta_cash));
      if (body.note) args.push("--note", String(body.note));
      execFileSync("node", args, {
        encoding: "utf8",
        cwd: ROOT,
        env: process.env,
        timeout: 30_000,
      });
      const latest = join(ROOT, "reports", "cashflow-latest.json");
      return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
    }

    if (url.pathname === "/ops/procedural-truth" && req.method === "POST") {
      const out = execFileSync("node", [join(ROOT, "scripts", "procedural-truth.mjs")], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, PTV_SOURCE: "ops-workflow" },
        timeout: 90_000,
      });
      try {
        return json(res, 200, JSON.parse(out));
      } catch {
        return json(res, 200, { raw: out });
      }
    }

    if (url.pathname === "/ops/goal-scorecard" && (req.method === "POST" || req.method === "GET")) {
      const out = execFileSync("node", [join(ROOT, "scripts", "goal-scorecard.mjs")], {
        encoding: "utf8",
        cwd: ROOT,
        env: process.env,
        timeout: 90_000,
      });
      const latest = join(ROOT, "reports", "goal-scorecard-latest.json");
      if (existsSync(latest)) {
        return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
      }
      try {
        return json(res, 200, JSON.parse(out));
      } catch {
        return json(res, 200, { raw: out });
      }
    }

    if (url.pathname === "/ops/deployments" && req.method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      const latest = join(ROOT, "reports", "deployments-latest.json");
      if (!refresh && existsSync(latest)) {
        return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
      }
      execFileSync("node", [join(ROOT, "scripts", "deployments-audit.mjs")], {
        encoding: "utf8",
        cwd: ROOT,
        env: process.env,
        timeout: 180_000,
      });
      if (existsSync(latest)) {
        return json(res, 200, JSON.parse(readFileSync(latest, "utf8")));
      }
      return json(res, 500, { error: "no deployments report" });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, {
      error: e instanceof Error ? e.message : String(e),
      stderr: e.stderr?.toString?.() || "",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ops-maintenance-http listening on http://${HOST}:${PORT}`);
});
