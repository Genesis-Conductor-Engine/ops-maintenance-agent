#!/usr/bin/env node
/**
 * Push ops status updates to Kimi mobile (OpenClaw-moY chat).
 * Prefers kimiim-cli notify-owner / send-message; falls back to openclaw agent deliver.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Load OpenClaw env (KIMI_BOT_TOKEN, etc.) when not already present
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv("/root/.openclaw/.env");

const CHAT_ID =
  process.env.KIMI_CHAT_ID || "19e8aada-1f62-8cfc-8000-09076ba9f59c";

const CHILD_ENV = {
  ...process.env,
  PATH: `/root/.local/bin:/usr/local/bin:${process.env.PATH || ""}`,
};

/** argv-based exec — never shell-interpolate message text (backticks/`!` break otherwise) */
function run(bin, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(bin, args, {
        encoding: "utf8",
        timeout: opts.timeout ?? 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: CHILD_ENV,
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function loadLatestReport() {
  const p = join(process.cwd(), "reports", "latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function buildMessage(report, extra = "") {
  const ts = new Date().toISOString();
  if (!report) {
    return `[ops-maintenance] ${ts}\nNo verification report yet. Run: npm run verify\n${extra}`.trim();
  }
  const blocked = report.summary?.blocked?.length
    ? report.summary.blocked.join(", ")
    : "none";
  const prs = report.gh?.prCount ?? "?";
  const lines = [
    `🛠 ops-maintenance cycle @ ${ts}`,
    `Services: ${report.summary.healthyServices}/${report.summary.totalServices}`,
    `Gateway: ${report.services?.["openclaw-gateway"] ?? "?"}`,
    `Kimi: ${report.kimi?.reachability?.ok ? "OK" : "DEGRADED"}`,
    `PRs open: ${prs}`,
    `Blocked: ${blocked}`,
    extra ? `\n${extra}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function sendKimiUpdate(message) {
  // Prefer notify-owner (bot → human mobile)
  const notify = run(
    "kimiim-cli",
    ["notify-owner", "--content", message],
    { timeout: 45_000 }
  );
  if (notify.ok) {
    return { channel: "notify-owner", ok: true, detail: notify.out };
  }

  // Fallback: send-message to known chat
  const send = run(
    "kimiim-cli",
    ["send-message", CHAT_ID, message],
    { timeout: 45_000 }
  );
  if (send.ok) {
    return { channel: "send-message", ok: true, detail: send.out };
  }

  return {
    channel: "none",
    ok: false,
    detail: [
      "notify-owner failed:",
      notify.out,
      "send-message failed:",
      send.out,
      "Ensure KIMI_BOT_TOKEN is set in /root/.openclaw/.env",
    ].join("\n"),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("kimi-update.mjs")) {
  const extra = process.argv.slice(2).join(" ");
  const report = loadLatestReport();
  const msg = buildMessage(report, extra);
  const result = sendKimiUpdate(msg);
  console.log(JSON.stringify({ message: msg, result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

export { buildMessage, loadLatestReport };
