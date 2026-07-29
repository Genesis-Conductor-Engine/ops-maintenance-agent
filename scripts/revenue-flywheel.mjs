#!/usr/bin/env node
/**
 * Revenue flywheel CLI — snapshot + actuate the 13-stream money loop.
 *
 * Usage:
 *   node scripts/revenue-flywheel.mjs              # snapshot → reports/
 *   node scripts/revenue-flywheel.mjs status       # same, pretty
 *   node scripts/revenue-flywheel.mjs seed-demo    # dry-run settle + ledger motion
 *   node scripts/revenue-flywheel.mjs challenge    # print 402 challenge for R01 pack
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS = join(ROOT, "reports");
const MONETIZE = process.env.X402_MONETIZE_URL || "http://127.0.0.1:8793";
const METER = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";
const PAY_TO =
  process.env.X402_PAY_TO_ADDRESS ||
  "0x9545e2439c5c75d3aA723AcaC1AA6B0fa1DB6956";

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function buildSnapshot() {
  const [monetizeHealth, flywheel, pricing, meterHealth, meterPricing] =
    await Promise.all([
      fetchJson(`${MONETIZE}/health`),
      fetchJson(`${MONETIZE}/flywheel`),
      fetchJson(`${MONETIZE}/pricing`),
      fetchJson(`${METER}/health`),
      fetchJson(`${METER}/pricing`),
    ]);

  const cashflow = loadJson(join(REPORTS, "cashflow-latest.json"));
  const r01 = loadJson(join(REPORTS, "r01-go-live.json"));
  const cycle = loadJson(join(REPORTS, "cycle-latest.json"));

  const snap = {
    at: new Date().toISOString(),
    story:
      "Agent demand → x402/Stripe pay → settle → Shopify attribution → cashflow → reinvest (GPU/marketplace/LP)",
    north_star: {
      streams: 13,
      mrr_floor: 70_000,
      combined: 910_000,
    },
    treasury: {
      pay_to: PAY_TO,
      note: "HOT Account1 / Safe owner — receives agent USDC on Base",
    },
    rails: {
      x402_monetize: {
        url: MONETIZE,
        health: monetizeHealth,
        dry_run: monetizeHealth?.body?.dryRun ?? null,
      },
      inference_meter: {
        url: METER,
        public: r01?.endpoints?.public_base_url || "https://inference.yennefer.quest",
        health: meterHealth,
        checkout_ready: meterPricing?.body?.checkout_ready ?? null,
      },
      shopify: {
        store: "51wnq0-ip.myshopify.com",
        module: "shopify-agentic",
        preview: true,
      },
    },
    catalog: pricing?.body?.products || flywheel?.body?.catalog || [],
    cashflow: {
      mrr_actual: cashflow?.totals?.mrr_actual ?? cashflow?.mrr_actual ?? 0,
      pipeline_usd: cashflow?.totals?.pipeline_usd ?? cashflow?.pipeline_usd ?? 0,
      cash_mtd: cashflow?.totals?.cash_collected_mtd ?? cashflow?.cash_collected_mtd ?? 0,
      gap_usd: cashflow?.totals?.gap_usd ?? cashflow?.gap_usd ?? 910_000,
      streams_at_floor: cashflow?.totals?.streams_at_floor ?? 0,
    },
    r01: r01?.revenue || null,
    cycle_inference: cycle?.inference || null,
    flywheel_loop: flywheel?.body?.loop || null,
    reinvest: flywheel?.body?.reinvest || null,
    blockers: [
      ...(flywheel?.body?.blockers || []),
      ...(r01?.go_live_blockers || []),
      monetizeHealth.ok ? null : "x402-monetize-server not healthy — start ops-x402-monetize",
      meterHealth.ok ? null : "inference-meter not healthy",
    ].filter(Boolean),
    actuation: {
      challenge: `curl -i '${MONETIZE}/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits'`,
      settle_scaffold:
        "POST /x402/settle with verified proof (X402_ALLOW_UNVERIFIED=1 only for local demo)",
      stripe: r01?.endpoints?.webhook_stripe,
      seed_catalog:
        "node shopify-agentic/scripts/seed-agentic-products.mjs",
      cycle: "node scripts/maintenance-cycle.mjs",
    },
  };

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(
    join(REPORTS, "revenue-flywheel-latest.json"),
    JSON.stringify(snap, null, 2),
  );
  return snap;
}

async function seedDemo() {
  // Unique demo tx each run so cashflow records (idempotent path uses fingerprint)
  const txHash = `0x${randomBytes(32).toString("hex")}`;
  const proof = {
    chainId: 8453,
    chainName: "base",
    txHash,
    agentId: "genesis-twin",
    streamId: "R01",
    payerAddress: "0x1111111111111111111111111111111111111111",
    payTo: PAY_TO,
    asset: "USDC",
    amountAtomic: "2500000",
    amountDisplay: "2.50",
    x402Resource: "urn:genesis:agentic:skill:inference-credits",
    verified: true,
  };

  const res = await fetch(`${MONETIZE}/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof, mint: true, mint_tier: "starter" }),
  });
  const body = await res.json().catch(() => ({}));
  const snap = await buildSnapshot();
  return { settle: body, snapshot: snap };
}

async function main() {
  const cmd = process.argv[2] || "status";

  if (cmd === "challenge") {
    const r = await fetchJson(
      `${MONETIZE}/x402/challenge?resource=urn:genesis:agentic:skill:inference-credits`,
    );
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === 402 || r.ok ? 0 : 1);
  }

  if (cmd === "seed-demo") {
    // Require monetize up
    const h = await fetchJson(`${MONETIZE}/health`);
    if (!h.ok) {
      console.error(
        JSON.stringify({
          error: "monetize_down",
          hint: "systemctl start ops-x402-monetize || node scripts/x402-monetize-server.mjs",
        }),
      );
      process.exit(2);
    }
    const out = await seedDemo();
    // Never print full API keys in seed-demo stdout if present — redact
    if (out.settle?.mint?.key) {
      out.settle.mint.key = "[redacted-in-cli-log]";
      out.settle.mint.note = "Key was minted; retrieve only from settle response once";
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const snap = await buildSnapshot();
  console.log(JSON.stringify(snap, null, 2));
  const healthy =
    snap.rails.x402_monetize.health?.ok && snap.rails.inference_meter.health?.ok;
  process.exit(healthy ? 0 : 1);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error(JSON.stringify({ error: String(e.message || e) }));
    process.exit(1);
  });
}
