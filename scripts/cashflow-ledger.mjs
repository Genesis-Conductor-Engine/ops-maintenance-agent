#!/usr/bin/env node
/**
 * Cashflow ledger for 13 revenue streams × $70k MRR floor.
 * Storage: Redis (primary when available) + reports/cashflow-latest.json (always).
 * Replaces Axiom as the local observability/KPI surface for money motion.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS = join(ROOT, "reports");
const REDIS_KEY = "diamondnode:cashflow:v1";
const MRR_FLOOR = 70_000;
const COMBINED_TARGET = 13 * MRR_FLOOR;

/** Canonical stream registry (from config_system / streams INDEX). */
export const STREAMS = [
  { id: "R01", name: "Sovereign LLM Inference API", agent: "genesis-twin" },
  { id: "R02", name: "Diamondnode GPU / q-mem", agent: "yennefer" },
  { id: "R03", name: "Genesis Conductor MCP", agent: "genesis-twin" },
  { id: "R04", name: "PQ attested credentials", agent: "blackhorse" },
  { id: "R05", name: "Coalition licensing", agent: "momus" },
  { id: "R06", name: "ATP / Vertex AI training", agent: "genesis-twin" },
  { id: "R07", name: "On-chain agent economy", agent: "genesis-twin" },
  { id: "R08", name: "Hybrid consciousness tooling", agent: "yennefer" },
  { id: "R09", name: "A2A skill marketplace", agent: "momus" },
  { id: "R10", name: "Deploy auto-scaler consulting", agent: "yennefer" },
  { id: "R11", name: "Seismic ToT consulting", agent: "yennefer" },
  { id: "R12", name: "Thermo publications & licensing", agent: "momus" },
  { id: "R13", name: "Sovereign white-label", agent: "genesis-twin" },
];

function redis(args) {
  try {
    return execFileSync("redis-cli", args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function loadDisk() {
  const p = join(REPORTS, "cashflow-latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadRedis() {
  const raw = redis(["GET", REDIS_KEY]);
  if (!raw || raw === "" || raw === "(nil)") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function defaultLedger() {
  const at = new Date().toISOString();
  return {
    version: 1,
    story: "13 streams × $70k MRR floor = $910k combined cashflow target",
    updated_at: at,
    currency: "USD",
    mrr_floor_per_stream: MRR_FLOOR,
    combined_target: COMBINED_TARGET,
    streams: STREAMS.map((s) => ({
      ...s,
      mrr_target: MRR_FLOOR,
      mrr_actual: 0,
      pipeline_usd: 0,
      cash_collected_mtd: 0,
      status: "configured", // configured | actuating | at_floor
      last_event: null,
    })),
    totals: {
      mrr_actual: 0,
      mrr_target: COMBINED_TARGET,
      pipeline_usd: 0,
      cash_collected_mtd: 0,
      pct_of_target: 0,
      streams_at_floor: 0,
      gap_usd: COMBINED_TARGET,
    },
    backend: "disk",
  };
}

function recompute(ledger) {
  let mrr = 0;
  let pipe = 0;
  let cash = 0;
  let atFloor = 0;
  for (const s of ledger.streams) {
    s.mrr_actual = Number(s.mrr_actual) || 0;
    s.pipeline_usd = Number(s.pipeline_usd) || 0;
    s.cash_collected_mtd = Number(s.cash_collected_mtd) || 0;
    s.mrr_target = s.mrr_target || MRR_FLOOR;
    if (s.mrr_actual >= s.mrr_target) {
      s.status = "at_floor";
      atFloor += 1;
    } else if (s.mrr_actual > 0 || s.pipeline_usd > 0) {
      s.status = "actuating";
    } else if (!s.status) {
      s.status = "configured";
    }
    mrr += s.mrr_actual;
    pipe += s.pipeline_usd;
    cash += s.cash_collected_mtd;
  }
  ledger.totals = {
    mrr_actual: mrr,
    mrr_target: COMBINED_TARGET,
    pipeline_usd: pipe,
    cash_collected_mtd: cash,
    pct_of_target: COMBINED_TARGET ? Math.round((mrr / COMBINED_TARGET) * 10000) / 100 : 0,
    streams_at_floor: atFloor,
    gap_usd: Math.max(0, COMBINED_TARGET - mrr),
  };
  ledger.updated_at = new Date().toISOString();
  return ledger;
}

function persist(ledger) {
  mkdirSync(REPORTS, { recursive: true });
  const json = JSON.stringify(ledger, null, 2);
  writeFileSync(join(REPORTS, "cashflow-latest.json"), json);
  writeFileSync(
    join(REPORTS, `cashflow-${ledger.updated_at.replace(/[:.]/g, "-")}.json`),
    json
  );
  const r = redis(["SET", REDIS_KEY, JSON.stringify(ledger)]);
  ledger.backend = r !== null ? "redis+disk" : "disk";
  if (r !== null) {
    // refresh with backend tag
    writeFileSync(join(REPORTS, "cashflow-latest.json"), JSON.stringify(ledger, null, 2));
    redis(["SET", REDIS_KEY, JSON.stringify(ledger)]);
  }
  return ledger;
}

export function loadLedger() {
  const fromRedis = loadRedis();
  const fromDisk = loadDisk();
  let ledger = fromRedis || fromDisk || defaultLedger();
  // Ensure all 13 streams exist (merge registry)
  const byId = new Map(ledger.streams.map((s) => [s.id, s]));
  ledger.streams = STREAMS.map((reg) => {
    const prev = byId.get(reg.id);
    return prev
      ? { ...reg, ...prev, id: reg.id, name: reg.name, agent: reg.agent }
      : {
          ...reg,
          mrr_target: MRR_FLOOR,
          mrr_actual: 0,
          pipeline_usd: 0,
          cash_collected_mtd: 0,
          status: "configured",
          last_event: null,
        };
  });
  return recompute(ledger);
}

/**
 * Record cashflow motion for a stream.
 * @param {string} streamId R01..R13
 * @param {{ mrr_actual?: number, pipeline_usd?: number, cash_collected_mtd?: number, delta_mrr?: number, delta_cash?: number, note?: string, shopify_order_id?: string, meta?: object }} patch
 */
export function recordCashflow(streamId, patch = {}) {
  const ledger = loadLedger();
  const s = ledger.streams.find((x) => x.id === streamId);
  if (!s) throw new Error(`unknown stream ${streamId}`);
  if (patch.mrr_actual != null) s.mrr_actual = Number(patch.mrr_actual);
  if (patch.pipeline_usd != null) s.pipeline_usd = Number(patch.pipeline_usd);
  if (patch.cash_collected_mtd != null) s.cash_collected_mtd = Number(patch.cash_collected_mtd);
  if (patch.delta_mrr) s.mrr_actual = Math.max(0, s.mrr_actual + Number(patch.delta_mrr));
  if (patch.delta_cash) s.cash_collected_mtd = Math.max(0, s.cash_collected_mtd + Number(patch.delta_cash));
  let meta = patch.meta && typeof patch.meta === "object" ? patch.meta : null;
  if (typeof patch.meta === "string") {
    try {
      meta = JSON.parse(patch.meta);
    } catch {
      meta = { raw: patch.meta };
    }
  }
  s.last_event = {
    at: new Date().toISOString(),
    note: patch.note || null,
    shopify_order_id: patch.shopify_order_id || meta?.shopify_order_id || null,
    meta: meta || null,
  };
  recompute(ledger);
  return persist(ledger);
}

export function snapshotCashflow() {
  const ledger = loadLedger();
  persist(ledger);
  return ledger;
}

export function formatCashflowBrief(ledger) {
  const t = ledger.totals;
  const top = [...ledger.streams]
    .sort((a, b) => b.mrr_actual - a.mrr_actual)
    .slice(0, 3)
    .map((s) => `${s.id}:$${s.mrr_actual}`)
    .join(" ");
  return [
    `Cashflow MRR $${t.mrr_actual}/$${t.mrr_target} (${t.pct_of_target}%)`,
    `Gap $${t.gap_usd} · at_floor ${t.streams_at_floor}/13`,
    `Pipeline $${t.pipeline_usd} · MTD cash $${t.cash_collected_mtd}`,
    `Backend ${ledger.backend}`,
    top ? `Top ${top}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// CLI
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("cashflow-ledger.mjs");

if (isMain) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "record" && rest[0]) {
    // record R01 --mrr 1000 --cash 500 --note "first invoice"
    // record R07 --delta-cash 2.5 --shopify-order-id gid://... --meta '{"txHash":"0x..."}'
    const id = rest[0];
    const patch = {};
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--mrr") patch.mrr_actual = Number(rest[++i]);
      else if (rest[i] === "--pipeline") patch.pipeline_usd = Number(rest[++i]);
      else if (rest[i] === "--cash") patch.cash_collected_mtd = Number(rest[++i]);
      else if (rest[i] === "--delta-mrr") patch.delta_mrr = Number(rest[++i]);
      else if (rest[i] === "--delta-cash") patch.delta_cash = Number(rest[++i]);
      else if (rest[i] === "--note") patch.note = rest[++i];
      else if (rest[i] === "--shopify-order-id") patch.shopify_order_id = rest[++i];
      else if (rest[i] === "--meta") patch.meta = rest[++i];
    }
    const L = recordCashflow(id, patch);
    console.log(formatCashflowBrief(L));
    process.exit(0);
  }
  const L = snapshotCashflow();
  console.log(formatCashflowBrief(L));
  console.log(JSON.stringify(L.totals, null, 2));
}
