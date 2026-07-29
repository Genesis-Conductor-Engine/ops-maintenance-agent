#!/usr/bin/env node
/**
 * x402 Monetize Service — HTTP surface for agent-paid Genesis products.
 *
 * Closes the monetize-service loop on diamondnode:
 *   challenge (402) → agent pays USDC on Base → settle proof →
 *   Shopify attribution (when token set) → cashflow ledger → optional API key mint
 *
 * Streams: R01 (inference credits), R05 (coalition seat), R07 (settlement), R09 (skill listing)
 *
 * Endpoints:
 *   GET  /health
 *   GET  /pricing
 *   GET  /flywheel
 *   GET  /x402/challenge?resource=&amount_usd=&stream=
 *   POST /x402/settle          { proof, mint_tier? }
 *   POST /x402/mint-credits    { settle_fingerprint, tier }  (after settle)
 *   GET  /discovery            Bazaar-style agent discovery catalog
 *
 * Settle verification: unless DRY_RUN or X402_ALLOW_UNVERIFIED=1 (explicit
 * scaffold escape hatches), /x402/settle no longer trusts a caller-supplied
 * proof.verified flag. It requires the claimed amount to meet the resource's
 * catalog price, then calls verifyOnChainReceipt() to confirm a real, successful
 * on-chain transaction with a matching USDC Transfer log to PAY_TO, at least
 * X402_MIN_CONFIRMATIONS deep. Fails closed on any RPC error or mismatch.
 */
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS = join(ROOT, "reports");
const STATE = join(ROOT, "shopify-agentic", "state");
const PORT = Number(process.env.X402_MONETIZE_PORT || 8793);
const BIND = process.env.X402_MONETIZE_BIND || "127.0.0.1";
const PAY_TO =
  process.env.X402_PAY_TO_ADDRESS ||
  "0x9545e2439c5c75d3aA723AcaC1AA6B0fa1DB6956"; // HOT Account1 / Safe owner treasury
const NETWORK = process.env.X402_DEFAULT_NETWORK || "base";
const CHAIN_ID = Number(process.env.X402_CHAIN_ID || 8453);
const FACILITATOR_SECRET = process.env.X402_FACILITATOR_SECRET || "";
const INFERENCE_ADMIN =
  process.env.INFERENCE_ADMIN_TOKEN || process.env.GATEWAY_SECRET || "";
const METER_URL = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";
const PUBLIC_BASE =
  process.env.X402_PUBLIC_BASE_URL ||
  process.env.INFERENCE_PUBLIC_URL ||
  "https://inference.yennefer.quest";
const ALLOW_UNVERIFIED = process.env.X402_ALLOW_UNVERIFIED === "1";
const DRY_RUN =
  process.env.SHOPIFY_ATTRIBUTION_DRY_RUN === "1" ||
  !process.env.SHOPIFY_ADMIN_TOKEN;

// --- On-chain settlement verification -------------------------------------
// Canonical native-USDC (Circle-issued) contract addresses per chain. Used to
// confirm a claimed payment is a real Transfer log, not just a caller's say-so.
const USDC_CONTRACTS = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism mainnet
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon PoS mainnet
};

// Same env var names/defaults as /root/agentic-arbitration's chain probe, so
// both tools agree on which RPC a given chain key resolves to.
function rpcUrlForChain(chainId) {
  switch (Number(chainId)) {
    case 8453:
      return (
        process.env.BASE_MAINNET_RPC ||
        process.env.BASE_RPC_URL ||
        "https://mainnet.base.org"
      );
    case 84532:
      return process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
    case 10:
      return (
        process.env.OPTIMISM_RPC_URL ||
        process.env.OP_RPC_URL ||
        "https://mainnet.optimism.io"
      );
    case 137:
      return (
        process.env.POLYGON_RPC_URL ||
        process.env.MATIC_RPC_URL ||
        "https://polygon-bor-rpc.publicnode.com"
      );
    case 1:
      return (
        process.env.ETH_RPC_URL ||
        process.env.MAINNET_RPC_URL ||
        "https://ethereum.publicnode.com"
      );
    default:
      return null;
  }
}

const MIN_CONFIRMATIONS = Number(process.env.X402_MIN_CONFIRMATIONS ?? 1);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "rpc_error");
  return body.result;
}

/**
 * Pure log-matching logic (no network) — find a Transfer(from?, to, value>=min)
 * log emitted by the expected USDC contract. Exported separately so it can be
 * unit-tested with synthetic receipts instead of live RPC fixtures.
 */
function findMatchingTransferLog(
  logs,
  { usdcAddress, expectedTo, minAmountAtomic, expectedFrom },
) {
  const to32 = expectedTo.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const from32 = expectedFrom
    ? expectedFrom.toLowerCase().replace(/^0x/, "").padStart(64, "0")
    : null;
  const min = BigInt(String(minAmountAtomic));

  for (const log of logs || []) {
    if (!log.address || log.address.toLowerCase() !== usdcAddress.toLowerCase()) {
      continue;
    }
    const topics = log.topics || [];
    if ((topics[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics.length < 3) continue;
    if (topics[2].toLowerCase() !== `0x${to32}`) continue;
    if (from32 && topics[1].toLowerCase() !== `0x${from32}`) continue;

    let value;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    if (value >= min) {
      return { ok: true, value: value.toString(), from: `0x${topics[1].slice(-40)}` };
    }
  }
  return { ok: false };
}

/**
 * Confirm a claimed USDC payment actually happened on-chain: a real, successful
 * transaction with a Transfer log from the canonical USDC contract to our payTo
 * address, for at least the claimed amount, at least MIN_CONFIRMATIONS deep.
 * Fails closed (ok: false) on any missing data, mismatch, unsupported chain, or
 * RPC error — never throws.
 */
async function verifyOnChainReceipt(proof) {
  const chainId = Number(proof.chainId) || CHAIN_ID;
  const rpcUrl = rpcUrlForChain(chainId);
  const usdcAddress = USDC_CONTRACTS[chainId];
  if (!rpcUrl || !usdcAddress) {
    return { ok: false, reason: "unsupported_chain", chainId };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(proof.txHash || ""))) {
    return { ok: false, reason: "bad_tx_hash" };
  }

  try {
    const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [
      proof.txHash,
    ]);
    if (!receipt) return { ok: false, reason: "tx_not_found" };
    if (receipt.status !== "0x1") return { ok: false, reason: "tx_failed" };

    const match = findMatchingTransferLog(receipt.logs, {
      usdcAddress,
      expectedTo: proof.payTo || PAY_TO,
      minAmountAtomic: proof.amountAtomic,
      expectedFrom: proof.payerAddress || null,
    });
    if (!match.ok) return { ok: false, reason: "no_matching_transfer_log" };

    if (MIN_CONFIRMATIONS > 0) {
      const latestHex = await rpcCall(rpcUrl, "eth_blockNumber", []);
      const latest = BigInt(latestHex);
      const receiptBlock = BigInt(receipt.blockNumber);
      if (latest - receiptBlock < BigInt(MIN_CONFIRMATIONS)) {
        return { ok: false, reason: "insufficient_confirmations" };
      }
    }

    return {
      ok: true,
      chainId,
      rpcUrl,
      txHash: proof.txHash,
      transferFrom: match.from,
    };
  } catch (e) {
    return { ok: false, reason: "rpc_error", error: String(e.message || e) };
  }
}

/** Catalog — maps resource URN → stream + default USD price */
const CATALOG = {
  "urn:genesis:agentic:skill:inference-credits": {
    sku: "AGENTIC-INFER-250",
    title: "Agentic inference credits (250)",
    price_usd: 2.5,
    stream: "R01",
    mint_tier: "starter",
    description: "250 metered inference requests via diamondnode q-mem / ollama",
  },
  "urn:genesis:agentic:skill:listing-30d": {
    sku: "AGENTIC-SKILL-LIST-30",
    title: "Skill marketplace listing (30d)",
    price_usd: 29,
    stream: "R09",
    mint_tier: null,
    description: "30-day listing fee on A2A skill registry",
  },
  "urn:genesis:agentic:license:coalition-seat": {
    sku: "AGENTIC-COALITION-SEAT",
    title: "Coalition license seat (monthly)",
    price_usd: 70,
    stream: "R05",
    mint_tier: null,
    description: "One monthly coalition license seat",
  },
  "urn:genesis:agentic:inference:chat": {
    sku: "AGENTIC-INFER-CHAT",
    title: "Pay-per chat completion (x402)",
    price_usd: 0.05,
    stream: "R01",
    mint_tier: "starter",
    description: "Single paid chat completion credit pack (mint starter key)",
  },
};

const SETTLES_PATH = join(STATE, "x402-settles.json");

function ensureDirs() {
  mkdirSync(REPORTS, { recursive: true });
  mkdirSync(STATE, { recursive: true });
}

function loadSettles() {
  ensureDirs();
  if (!existsSync(SETTLES_PATH)) return { settles: {} };
  try {
    return JSON.parse(readFileSync(SETTLES_PATH, "utf8"));
  } catch {
    return { settles: {} };
  }
}

function saveSettles(data) {
  ensureDirs();
  writeFileSync(SETTLES_PATH, JSON.stringify(data, null, 2));
}

function usdToAtomic(usd) {
  return String(Math.round(Number(usd) * 1e6));
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function authorize(req) {
  if (!FACILITATOR_SECRET) return { ok: true, note: "no_secret" };
  const h =
    req.headers["x-x402-secret"] ||
    req.headers["x-facilitator-secret"] ||
    "";
  if (!h) return { ok: false, reason: "missing_secret" };
  const a = Buffer.from(String(h));
  const b = Buffer.from(FACILITATOR_SECRET);
  if (a.length !== b.length) return { ok: false, reason: "bad_secret" };
  try {
    if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad_secret" };
  } catch {
    return { ok: false, reason: "bad_secret" };
  }
  return { ok: true };
}

function createChallenge({ resource, amountUsd, stream, agentId }) {
  const res =
    resource && CATALOG[resource]
      ? resource
      : "urn:genesis:agentic:skill:inference-credits";
  const cat = CATALOG[res];
  const usd = amountUsd != null ? Number(amountUsd) : cat.price_usd;
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const amountAtomic = usdToAtomic(usd);

  return {
    status: 402,
    body: {
      x402Version: 1,
      scheme: "exact",
      error: "Payment Required",
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          chainId: CHAIN_ID,
          asset: "USDC",
          amount: amountAtomic,
          amountDisplay: String(usd),
          payTo: PAY_TO,
          resource: res,
          description: cat.description,
          maxTimeoutSeconds: 600,
          extra: {
            sku: cat.sku,
            title: cat.title,
            stream: stream || cat.stream,
            agentId: agentId || null,
            nonce,
            expiresAt,
            shop: "51wnq0-ip.myshopify.com",
            public_inference: PUBLIC_BASE,
          },
        },
      ],
      discovery: {
        output: {
          example: {
            status: "settled",
            stream: cat.stream,
            amount_usd: usd,
          },
          schema: {
            properties: {
              status: { type: "string" },
              stream: { type: "string" },
              amount_usd: { type: "number" },
            },
          },
        },
      },
    },
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "shopify-agentic", "src", "cli.mjs"), ...args],
      {
        cwd: join(ROOT, "shopify-agentic"),
        env: {
          ...process.env,
          X402_PAY_TO_ADDRESS: PAY_TO,
          X402_DEFAULT_NETWORK: NETWORK,
          SHOPIFY_ATTRIBUTION_DRY_RUN: DRY_RUN ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = { raw: out.trim() };
      }
      resolve({ code, out: out.trim(), err: err.trim(), parsed });
    });
    child.on("error", (e) => resolve({ code: 1, error: String(e.message || e) }));
  });
}

async function mintInferenceKey(tier, label) {
  if (!INFERENCE_ADMIN) {
    return { ok: false, error: "INFERENCE_ADMIN_TOKEN not set" };
  }
  try {
    const res = await fetch(`${METER_URL}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INFERENCE_ADMIN}`,
        "X-Admin-Token": INFERENCE_ADMIN,
      },
      body: JSON.stringify({ tier, label }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, body };
    return {
      ok: true,
      // only return prefix + id in durable state; full key once to caller
      key: body.key,
      id: body.id,
      tier: body.tier,
      prefix: body.key ? String(body.key).slice(0, 12) + "…" : body.prefix,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function recordLedger(stream, deltaCash, note, meta = {}) {
  return new Promise((resolve) => {
    const args = [
      join(ROOT, "scripts", "cashflow-ledger.mjs"),
      "record",
      stream,
      "--delta-cash",
      String(deltaCash || 0),
      "--note",
      note,
    ];
    if (meta.shopify_order_id) {
      args.push("--shopify-order-id", String(meta.shopify_order_id));
    }
    if (Object.keys(meta).length) {
      args.push("--meta", JSON.stringify({ source: "x402-monetize", ...meta }));
    }
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      resolve({ code, out: out.trim(), err: err.trim() }),
    );
    child.on("error", (e) => resolve({ error: String(e.message || e) }));
  });
}

function flywheelSnapshot() {
  let cashflow = null;
  let r01 = null;
  try {
    cashflow = JSON.parse(
      readFileSync(join(REPORTS, "cashflow-latest.json"), "utf8"),
    );
  } catch {
    /* empty */
  }
  try {
    r01 = JSON.parse(readFileSync(join(REPORTS, "r01-go-live.json"), "utf8"));
  } catch {
    /* empty */
  }
  const settles = loadSettles();
  const settleCount = Object.keys(settles.settles || {}).length;

  return {
    at: new Date().toISOString(),
    north_star: {
      streams: 13,
      mrr_floor_each: 70_000,
      combined_mrr_target: 910_000,
    },
    loop: [
      "1. Agent discovers product (GET /discovery or Shopify catalog)",
      "2. Agent requests resource → 402 challenge (GET /x402/challenge)",
      "3. Agent pays USDC on Base to payTo",
      "4. Agent POSTs proof → /x402/settle (verified)",
      "5. Facilitator attributes Shopify order + cashflow ledger",
      "6. Optional: mint inference API key (R01) → usage on public meter",
      "7. Maintenance cycle aggregates MRR → reinvest GPU / marketplace / LP",
    ],
    pay_to: PAY_TO,
    network: NETWORK,
    chain_id: CHAIN_ID,
    dry_run_attribution: DRY_RUN,
    public_inference: PUBLIC_BASE,
    endpoints: {
      health: `http://${BIND}:${PORT}/health`,
      pricing: `http://${BIND}:${PORT}/pricing`,
      challenge: `http://${BIND}:${PORT}/x402/challenge`,
      settle: `http://${BIND}:${PORT}/x402/settle`,
      discovery: `http://${BIND}:${PORT}/discovery`,
      flywheel: `http://${BIND}:${PORT}/flywheel`,
    },
    catalog: Object.entries(CATALOG).map(([resource, v]) => ({
      resource,
      ...v,
    })),
    metrics: {
      x402_settles_recorded: settleCount,
      cashflow_mrr_actual: cashflow?.totals?.mrr_actual ?? cashflow?.mrr_actual ?? null,
      cashflow_pipeline_usd: cashflow?.totals?.pipeline_usd ?? cashflow?.pipeline_usd ?? null,
      r01_estimated_mrr: r01?.revenue?.estimated_mrr ?? null,
      r01_active_keys: r01?.revenue?.active_keys ?? null,
      r01_public_edge_ok: r01?.readiness?.public_edge_ok ?? null,
      stripe_checkout_ready: r01?.readiness?.stripe_checkout_urls_any ?? false,
    },
    reinvest: {
      R01: "Scale q-mem / ollama capacity when paid RPS > 50% of free pool",
      R07: "Sweep x402 USDC → Aerodrome LP / Safe treasury (9545 owner)",
      R09: "List paid skills; recycle listing fees into marketplace liquidity",
      R05: "Coalition seats fund attestation (R04) + white-label (R13)",
    },
    blockers: [
      DRY_RUN
        ? "Shopify Admin token missing — attribution dry-run only (Save store + install app)"
        : null,
      !process.env.STRIPE_WEBHOOK_SECRET
        ? "Stripe path optional: STRIPE_WEBHOOK_SECRET unset (card MRR path)"
        : null,
      FACILITATOR_SECRET
        ? null
        : "X402_FACILITATOR_SECRET unset — settle open on localhost (set before public expose)",
    ].filter(Boolean),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "x402-monetize-server",
        streams: ["R01", "R05", "R07", "R09"],
        payTo: PAY_TO,
        network: NETWORK,
        dryRun: DRY_RUN,
        port: PORT,
      });
    }

    if (req.method === "GET" && url.pathname === "/pricing") {
      return json(res, 200, {
        currency: "USD",
        asset: "USDC",
        network: NETWORK,
        chainId: CHAIN_ID,
        payTo: PAY_TO,
        products: Object.entries(CATALOG).map(([resource, v]) => ({
          resource,
          ...v,
          amount_atomic: usdToAtomic(v.price_usd),
          challenge: `/x402/challenge?resource=${encodeURIComponent(resource)}`,
        })),
        dual_rail: {
          x402: "Agent USDC per-request / credit packs (this service)",
          stripe: `${PUBLIC_BASE}/pricing` + " subscription tiers when Payment Links set",
          inference_meter: METER_URL,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/flywheel") {
      const snap = flywheelSnapshot();
      writeFileSync(
        join(REPORTS, "revenue-flywheel-latest.json"),
        JSON.stringify(snap, null, 2),
      );
      return json(res, 200, snap);
    }

    if (req.method === "GET" && url.pathname === "/discovery") {
      return json(res, 200, {
        name: "Genesis Agentic Commerce",
        protocol: "x402",
        version: 1,
        payTo: PAY_TO,
        network: NETWORK,
        shop: "51wnq0-ip.myshopify.com",
        resources: Object.entries(CATALOG).map(([resource, v]) => ({
          resource,
          title: v.title,
          price_usd: v.price_usd,
          stream: v.stream,
          description: v.description,
          accepts: {
            scheme: "exact",
            network: NETWORK,
            asset: "USDC",
            payTo: PAY_TO,
          },
        })),
      });
    }

    if (req.method === "GET" && url.pathname === "/x402/challenge") {
      const resource =
        url.searchParams.get("resource") ||
        "urn:genesis:agentic:skill:inference-credits";
      const amountUsd = url.searchParams.get("amount_usd");
      const stream = url.searchParams.get("stream");
      const agentId = url.searchParams.get("agent_id");
      const ch = createChallenge({
        resource,
        amountUsd: amountUsd != null ? Number(amountUsd) : undefined,
        stream,
        agentId,
      });
      return json(res, 402, ch.body, {
        "Payment-Required": "x402",
        "WWW-Authenticate": 'x402 scheme="exact"',
      });
    }

    if (req.method === "POST" && url.pathname === "/x402/settle") {
      const auth = authorize(req);
      if (!auth.ok) return json(res, 401, { error: auth.reason });

      const body = await readBody(req);
      const proof = body.proof || body;
      if (!proof.txHash || !proof.amountAtomic) {
        return json(res, 400, {
          error: "proof requires txHash, amountAtomic, chainId",
        });
      }

      const resource =
        proof.x402Resource ||
        proof.resource ||
        "urn:genesis:agentic:skill:inference-credits";
      const cat = CATALOG[resource] || CATALOG["urn:genesis:agentic:skill:inference-credits"];
      const streamId = proof.streamId || cat.stream || "R07";
      const amountDisplay =
        proof.amountDisplay ||
        String(Number(proof.amountAtomic) / 1e6);

      // Real path: never trust a caller-supplied proof.verified. DRY_RUN and
      // ALLOW_UNVERIFIED are the only scaffold escape hatches, unchanged from before.
      let verification = null;
      if (!DRY_RUN && !ALLOW_UNVERIFIED) {
        const minRequiredAtomic = usdToAtomic(cat.price_usd);
        if (BigInt(String(proof.amountAtomic)) < BigInt(minRequiredAtomic)) {
          return json(res, 402, {
            error: "underpaid",
            resource,
            required_atomic: minRequiredAtomic,
            hint: `${resource} requires at least $${cat.price_usd} (${minRequiredAtomic} atomic USDC)`,
          });
        }
        verification = await verifyOnChainReceipt(proof);
        if (!verification.ok) {
          return json(res, 402, {
            error: "unverified",
            reason: verification.reason,
            detail: verification.error,
            hint: "On-chain receipt did not confirm this payment via RPC. proof.verified from the caller is not trusted — X402_ALLOW_UNVERIFIED=1 remains a local-scaffold-only override.",
          });
        }
      }

      const proofPayload = {
        chainId: proof.chainId || CHAIN_ID,
        chainName: proof.chainName || NETWORK,
        txHash: proof.txHash,
        agentId: proof.agentId || "agent",
        streamId,
        payerAddress: proof.payerAddress,
        payTo: proof.payTo || PAY_TO,
        asset: proof.asset || "USDC",
        amountAtomic: String(proof.amountAtomic),
        amountDisplay,
        currencyCode: "USD",
        x402Nonce: proof.x402Nonce || randomBytes(8).toString("hex"),
        x402Resource: resource,
        verified: DRY_RUN || ALLOW_UNVERIFIED || Boolean(verification?.ok),
        lineItems: proof.lineItems || [
          {
            title: cat.title,
            quantity: 1,
            price: amountDisplay,
            sku: cat.sku,
          },
        ],
      };

      // Prefer dry-run CLI when no Shopify token; live settle otherwise
      const cli = DRY_RUN
        ? await runCli(["dry-run", proofPayload.txHash])
        : await runCli(["settle", JSON.stringify(proofPayload)]);

      const fingerprint = createHash("sha256")
        .update(`${proofPayload.chainId}:${proofPayload.txHash}`)
        .digest("hex")
        .slice(0, 16);

      // Always book cashflow for new fingerprints (CLI may skip on idempotent)
      const store = loadSettles();
      let cashflow = null;
      let mint = null;
      if (!store.settles[fingerprint]) {
        cashflow = await recordLedger(
          streamId,
          Number(amountDisplay),
          `x402 ${NETWORK} ${proofPayload.txHash} ${resource}`,
          {
            txHash: proofPayload.txHash,
            resource,
            agentId: proofPayload.agentId,
            dry_run: DRY_RUN,
          },
        );

        const wantMint =
          body.mint_tier ||
          (body.mint !== false && cat.mint_tier) ||
          null;
        if (wantMint) {
          mint = await mintInferenceKey(
            typeof wantMint === "string" ? wantMint : cat.mint_tier || "starter",
            `x402:${fingerprint}`,
          );
        }

        store.settles[fingerprint] = {
          at: new Date().toISOString(),
          streamId,
          resource,
          amountDisplay,
          txHash: proofPayload.txHash,
          dryRun: DRY_RUN,
          verification: verification
            ? {
                ok: verification.ok,
                reason: verification.reason || null,
                transferFrom: verification.transferFrom || null,
              }
            : { ok: null, reason: ALLOW_UNVERIFIED ? "allow_unverified_scaffold" : "dry_run" },
          mint_id: mint?.id || null,
          mint_prefix: mint?.prefix || null,
        };
        saveSettles(store);
      } else {
        cashflow = { skipped: true, reason: "already_settled_locally" };
      }

      // Refresh flywheel report
      writeFileSync(
        join(REPORTS, "revenue-flywheel-latest.json"),
        JSON.stringify(flywheelSnapshot(), null, 2),
      );

      return json(res, 200, {
        status: store.settles[fingerprint] ? "settled" : "ok",
        fingerprint,
        dry_run: DRY_RUN,
        attribution: cli.parsed,
        cashflow,
        mint: mint
          ? {
              ok: mint.ok,
              id: mint.id,
              tier: mint.tier,
              prefix: mint.prefix,
              // full key only once on mint success
              key: mint.ok ? mint.key : undefined,
              warning: mint.ok
                ? "Store this key now; it is not re-shown in full."
                : mint.error || mint.body,
            }
          : null,
        next: {
          inference: PUBLIC_BASE + "/v1/chat/completions",
          pricing: PUBLIC_BASE + "/pricing",
          flywheel: `http://${BIND}:${PORT}/flywheel`,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/x402/mint-credits") {
      const auth = authorize(req);
      if (!auth.ok) return json(res, 401, { error: auth.reason });
      const body = await readBody(req);
      const fp = body.settle_fingerprint || body.fingerprint;
      const store = loadSettles();
      if (!fp || !store.settles[fp]) {
        return json(res, 404, { error: "unknown_settle_fingerprint" });
      }
      const tier = body.tier || "starter";
      const mint = await mintInferenceKey(tier, `x402-remint:${fp}`);
      if (mint.ok) {
        store.settles[fp].mint_id = mint.id;
        store.settles[fp].mint_prefix = mint.prefix;
        saveSettles(store);
      }
      return json(res, mint.ok ? 201 : 502, {
        ok: mint.ok,
        id: mint.id,
        tier: mint.tier,
        key: mint.key,
        prefix: mint.prefix,
        error: mint.error,
      });
    }

    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  ensureDirs();
  server.listen(PORT, BIND, () => {
    const snap = flywheelSnapshot();
    writeFileSync(
      join(REPORTS, "revenue-flywheel-latest.json"),
      JSON.stringify(snap, null, 2),
    );
    console.log(
      JSON.stringify({
        listening: `http://${BIND}:${PORT}`,
        service: "x402-monetize-server",
        payTo: PAY_TO,
        dryRun: DRY_RUN,
        catalog: Object.keys(CATALOG).length,
      }),
    );
  });
}

export {
  createChallenge,
  flywheelSnapshot,
  CATALOG,
  PAY_TO,
  findMatchingTransferLog,
  verifyOnChainReceipt,
  rpcUrlForChain,
  USDC_CONTRACTS,
};
