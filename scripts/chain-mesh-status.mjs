#!/usr/bin/env node
/**
 * Report agentic network mesh readiness for cashflow arbitration.
 * Reads registry + optional alloy probe + hardhat presence.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REG = join(ROOT, "chains", "agentic-networks.json");

function sh(cmd, args, timeout = 60_000) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: "utf8",
        timeout,
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

const reg = JSON.parse(readFileSync(REG, "utf8"));

const checks = {
  registry: REG,
  hardhat_ledger: existsSync(
    "/home/diamondnode/Yennefer/node_modules/@nomicfoundation/hardhat-ledger"
  ),
  hardhat_config: existsSync("/home/diamondnode/Yennefer/hardhat.config.cjs"),
  aerodrome_lp: existsSync("/home/diamondnode/Yennefer/aerodrome-lp"),
  alloy_crate: existsSync("/root/agentic-arbitration/Cargo.toml"),
  thirdweb_scaffold: existsSync(join(ROOT, "chains/thirdweb/package.json")),
  cashflow_ledger: existsSync(join(ROOT, "reports/cashflow-latest.json")),
};

// alloy probe (best effort — may fail offline)
let alloy = null;
const alloyBin = "/root/agentic-arbitration/target/release/agentic_arbitration";
const alloyDebug = "/root/agentic-arbitration/target/debug/agentic_arbitration";
const bin = existsSync(alloyBin) ? alloyBin : existsSync(alloyDebug) ? alloyDebug : null;
if (bin) {
  const r = sh(bin, ["probe", "--chain", "all"], 90_000);
  try {
    alloy = JSON.parse(r.out);
  } catch {
    alloy = { raw: r.out.slice(0, 2000), ok: r.ok };
  }
} else {
  alloy = { ok: false, note: "run: cd /root/agentic-arbitration && cargo build --release" };
}

const report = {
  at: new Date().toISOString(),
  purpose: reg.purpose,
  checks,
  networks: reg.networks.map((n) => n.id),
  agentic_surfaces: reg.agentic_surfaces.map((s) => s.name),
  alloy_probe: alloy,
  cashflow_streams_on_chain: ["R07", "R05", "R09", "R12"],
};

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", "chain-mesh-latest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
