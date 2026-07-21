#!/usr/bin/env node
/**
 * R01/R02 metered OpenAI-compatible inference gateway.
 *
 * - API key auth (Bearer sk_... or X-API-Key)
 * - Proxies to q-mem (primary :8082) then ollama (:11434)
 * - Meters tokens + requests in Redis
 * - Pricing tiers for cashflow pipeline / invoices
 *
 * Endpoints:
 *   GET  /health
 *   GET  /pricing
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *   POST /v1/completions
 *   POST /admin/keys          (requires ADMIN_TOKEN)
 *   GET  /admin/usage?key=   (requires ADMIN_TOKEN)
 *   GET  /admin/revenue      (requires ADMIN_TOKEN)
 */
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS = join(ROOT, "reports");
const PORT = Number(process.env.INFERENCE_METER_PORT || 8792);
const QMEM = process.env.QMEM_URL || "http://127.0.0.1:8082";
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ADMIN_TOKEN =
  process.env.INFERENCE_ADMIN_TOKEN ||
  process.env.GATEWAY_SECRET ||
  "";
const REDIS_PREFIX = "diamondnode:inference:";
const KEYS_REDIS = `${REDIS_PREFIX}keys`;
const USAGE_REDIS = `${REDIS_PREFIX}usage:`;
const LOCAL_KEYS = join(REPORTS, "inference-keys.json");

/** USD per 1M tokens (prompt/completion same for simplicity on GTX 1650 host). */
const TIERS = {
  free: {
    price_mo: 0,
    req_day: 50,
    rpm: 5,
    models: ["phi-2", "phi-2.Q4_K_M.gguf", "qwen2:0.5b"],
    usd_per_mtok: 0,
  },
  starter: {
    price_mo: 29,
    req_day: 5_000,
    rpm: 30,
    models: ["*"],
    usd_per_mtok: 0.4,
  },
  pro: {
    price_mo: 149,
    req_day: 50_000,
    rpm: 120,
    models: ["*"],
    usd_per_mtok: 0.25,
  },
  enterprise: {
    price_mo: 999,
    req_day: 1_000_000,
    rpm: 600,
    models: ["*"],
    usd_per_mtok: 0.12,
  },
};

function redis(args) {
  try {
    return execFileSync("redis-cli", args, {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function loadKeysDisk() {
  mkdirSync(REPORTS, { recursive: true });
  if (!existsSync(LOCAL_KEYS)) return { keys: {} };
  try {
    return JSON.parse(readFileSync(LOCAL_KEYS, "utf8"));
  } catch {
    return { keys: {} };
  }
}

function saveKeysDisk(store) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(LOCAL_KEYS, JSON.stringify(store, null, 2));
  redis(["SET", KEYS_REDIS, JSON.stringify(store)]);
}

function loadKeys() {
  const raw = redis(["GET", KEYS_REDIS]);
  if (raw && raw !== "(nil)") {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  return loadKeysDisk();
}

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function mintKey(tier = "starter", label = "default") {
  const store = loadKeys();
  const raw = `sk_live_${randomBytes(24).toString("base64url")}`;
  const id = hashKey(raw).slice(0, 16);
  store.keys[id] = {
    id,
    hash: hashKey(raw),
    tier,
    label,
    created_at: new Date().toISOString(),
    active: true,
    // prefix only for display
    prefix: raw.slice(0, 12) + "…",
  };
  saveKeysDisk(store);
  return { raw, meta: store.keys[id] };
}

function resolveKey(raw) {
  if (!raw) return null;
  const store = loadKeys();
  const h = hashKey(raw);
  for (const k of Object.values(store.keys || {})) {
    if (k.hash === h && k.active !== false) return k;
  }
  return null;
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage(keyId) {
  const raw = redis(["GET", `${USAGE_REDIS}${keyId}:${dayKey()}`]);
  if (raw && raw !== "(nil)") {
    try {
      return JSON.parse(raw);
    } catch {
      /* empty */
    }
  }
  return {
    day: dayKey(),
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_usd: 0,
  };
}

function addUsage(keyId, tier, usage) {
  const u = getUsage(keyId);
  const pt = Number(usage.prompt_tokens) || 0;
  const ct = Number(usage.completion_tokens) || 0;
  const rate = TIERS[tier]?.usd_per_mtok || 0;
  const cost = ((pt + ct) / 1_000_000) * rate;
  u.requests += 1;
  u.prompt_tokens += pt;
  u.completion_tokens += ct;
  u.estimated_usd = Math.round((u.estimated_usd + cost) * 1e6) / 1e6;
  u.updated_at = new Date().toISOString();
  redis(["SET", `${USAGE_REDIS}${keyId}:${dayKey()}`, JSON.stringify(u)]);
  redis(["EXPIRE", `${USAGE_REDIS}${keyId}:${dayKey()}`, String(60 * 60 * 48)]);
  // aggregate all keys for cashflow
  const aggKey = `${REDIS_PREFIX}agg:${dayKey()}`;
  const aggRaw = redis(["GET", aggKey]);
  let agg = { day: dayKey(), requests: 0, tokens: 0, estimated_usd: 0 };
  if (aggRaw && aggRaw !== "(nil)") {
    try {
      agg = JSON.parse(aggRaw);
    } catch {
      /* empty */
    }
  }
  agg.requests += 1;
  agg.tokens += pt + ct;
  agg.estimated_usd = Math.round((agg.estimated_usd + cost) * 1e6) / 1e6;
  redis(["SET", aggKey, JSON.stringify(agg)]);
  redis(["EXPIRE", aggKey, String(60 * 60 * 48)]);
  // write report snapshot
  try {
    mkdirSync(REPORTS, { recursive: true });
    writeFileSync(
      join(REPORTS, "inference-usage-latest.json"),
      JSON.stringify({ at: new Date().toISOString(), key: keyId, usage: u, agg }, null, 2)
    );
  } catch {
    /* ignore */
  }
  return u;
}

function extractAuth(req) {
  const h = req.headers.authorization || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return "";
}

function json(res, code, body) {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "Content-Type, Authorization, X-API-Key, X-Payment-Proof",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(raw);
}

async function proxyJson(url, body, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: text.slice(0, 500), type: "upstream_error" } };
    }
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function proxyGet(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    try {
      return { status: r.status, data: JSON.parse(text) };
    } catch {
      return { status: r.status, data: { raw: text.slice(0, 500) } };
    }
  } finally {
    clearTimeout(t);
  }
}

function modelAllowed(tier, model) {
  const m = model || "";
  const allow = TIERS[tier]?.models || [];
  if (allow.includes("*")) return true;
  return allow.some((a) => m === a || m.includes(a));
}

async function handleChat(req, res, keyMeta, body) {
  const tier = keyMeta.tier || "free";
  const usage = getUsage(keyMeta.id);
  const limit = TIERS[tier]?.req_day ?? 50;
  if (usage.requests >= limit) {
    return json(res, 429, {
      error: {
        message: `Daily request limit (${limit}) exceeded for tier ${tier}`,
        type: "rate_limit_error",
        code: "daily_limit",
      },
    });
  }
  const model = body.model || "phi-2.Q4_K_M.gguf";
  if (!modelAllowed(tier, model)) {
    return json(res, 403, {
      error: {
        message: `Model ${model} not allowed on tier ${tier}`,
        type: "permission_error",
      },
    });
  }

  // Prefer q-mem OpenAI path
  let upstream = await proxyJson(`${QMEM}/v1/chat/completions`, {
    ...body,
    model,
  });

  // Fallback: ollama openai-compat if qmem unavailable
  if (upstream.status >= 500 || upstream.status === 503) {
    const ollamaModel =
      model.includes("phi") || model.includes("Q4")
        ? "llama3.2:3b"
        : model;
    upstream = await proxyJson(`${OLLAMA}/v1/chat/completions`, {
      ...body,
      model: ollamaModel,
    });
  }

  const u = upstream.data?.usage || {};
  addUsage(keyMeta.id, tier, {
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
  });

  // annotate
  if (upstream.data && typeof upstream.data === "object") {
    upstream.data.diamondnode = {
      stream: "R01",
      tier,
      key_id: keyMeta.id,
      billed_day: dayKey(),
    };
  }
  return json(res, upstream.status, upstream.data);
}

async function handleCompletions(req, res, keyMeta, body) {
  // map to chat for consistency
  const prompt = body.prompt || "";
  return handleChat(req, res, keyMeta, {
    ...body,
    messages: [{ role: "user", content: String(prompt) }],
  });
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

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    json(res, 503, { error: "ADMIN_TOKEN not configured" });
    return false;
  }
  const tok = extractAuth(req);
  if (tok !== ADMIN_TOKEN) {
    json(res, 401, { error: "admin auth required" });
    return false;
  }
  return true;
}

function revenueSnapshot() {
  const store = loadKeys();
  const keys = Object.values(store.keys || {});
  let mrr = 0;
  const byTier = {};
  for (const k of keys) {
    if (!k.active) continue;
    const t = TIERS[k.tier] || TIERS.free;
    mrr += t.price_mo || 0;
    byTier[k.tier] = (byTier[k.tier] || 0) + 1;
  }
  const aggRaw = redis(["GET", `${REDIS_PREFIX}agg:${dayKey()}`]);
  let today = { requests: 0, tokens: 0, estimated_usd: 0 };
  if (aggRaw && aggRaw !== "(nil)") {
    try {
      today = JSON.parse(aggRaw);
    } catch {
      /* empty */
    }
  }
  return {
    at: new Date().toISOString(),
    active_keys: keys.filter((k) => k.active).length,
    by_tier: byTier,
    estimated_mrr_usd: mrr,
    usage_today: today,
    tiers: Object.fromEntries(
      Object.entries(TIERS).map(([id, t]) => [
        id,
        { price_mo: t.price_mo, req_day: t.req_day, usd_per_mtok: t.usd_per_mtok },
      ])
    ),
    stream: "R01",
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "Content-Type, Authorization, X-API-Key, X-Payment-Proof",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      return res.end();
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const q = await proxyGet(`${QMEM}/health`).catch(() => ({
        status: 0,
        data: { error: "unreachable" },
      }));
      return json(res, 200, {
        ok: true,
        service: "diamondnode-inference-meter",
        streams: ["R01", "R02"],
        qmem: q.data,
        port: PORT,
      });
    }

    if (req.method === "GET" && url.pathname === "/pricing") {
      return json(res, 200, {
        currency: "USD",
        stream: "R01",
        story: "Sovereign LLM Inference API on diamondnode (q-mem + ollama dual-backend)",
        pricing: TIERS,
        checkout_note:
          "Issue keys via POST /admin/keys with admin token. Stripe checkout for telemetry is at api.genesisconductor.io/pricing.",
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const auth = extractAuth(req);
      // models list is public-ish but still prefers key
      const q = await proxyGet(`${QMEM}/v1/models`).catch(() => null);
      const models =
        q?.data?.data ||
        q?.data?.models ||
        [{ id: "phi-2.Q4_K_M.gguf", object: "model", owned_by: "diamondnode" }];
      return json(res, 200, {
        object: "list",
        data: Array.isArray(models)
          ? models.map((m) =>
              typeof m === "string"
                ? { id: m, object: "model", owned_by: "diamondnode" }
                : {
                    id: m.id || m.name || m.model,
                    object: "model",
                    owned_by: "diamondnode",
                  }
            )
          : [],
        auth_present: Boolean(auth),
      });
    }

    if (req.method === "POST" && url.pathname === "/admin/keys") {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const tier = body.tier || "starter";
      if (!TIERS[tier]) return json(res, 400, { error: `unknown tier ${tier}` });
      const minted = mintKey(tier, body.label || "api");
      return json(res, 201, {
        key: minted.raw,
        id: minted.meta.id,
        tier: minted.meta.tier,
        label: minted.meta.label,
        price_mo: TIERS[tier].price_mo,
        warning: "Store this key now; it is not re-shown in full.",
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/usage") {
      if (!requireAdmin(req, res)) return;
      const keyId = url.searchParams.get("key_id");
      if (!keyId) return json(res, 400, { error: "key_id required" });
      return json(res, 200, getUsage(keyId));
    }

    if (req.method === "GET" && url.pathname === "/admin/revenue") {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, revenueSnapshot());
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions")
    ) {
      const rawKey = extractAuth(req);
      const keyMeta = resolveKey(rawKey);
      if (!keyMeta) {
        return json(res, 401, {
          error: {
            message: "Invalid or missing API key. Use Authorization: Bearer sk_live_…",
            type: "auth_error",
          },
        });
      }
      const body = await readBody(req);
      if (url.pathname === "/v1/completions") {
        return handleCompletions(req, res, keyMeta, body);
      }
      return handleChat(req, res, keyMeta, body);
    }

    return json(res, 404, {
      error: "Not found",
      available: [
        "GET /health",
        "GET /pricing",
        "GET /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/completions",
        "POST /admin/keys",
        "GET /admin/revenue",
      ],
    });
  } catch (e) {
    return json(res, 500, { error: { message: String(e?.message || e) } });
  }
});

// CLI helpers
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("inference-meter.mjs");

if (isMain && process.argv[2] === "mint") {
  const tier = process.argv[3] || "starter";
  const label = process.argv[4] || "cli";
  // ensure admin path works offline
  if (!existsSync(LOCAL_KEYS)) saveKeysDisk({ keys: {} });
  const m = mintKey(tier, label);
  console.log(JSON.stringify({ key: m.raw, id: m.meta.id, tier, price_mo: TIERS[tier].price_mo }, null, 2));
  process.exit(0);
}

if (isMain && process.argv[2] === "revenue") {
  console.log(JSON.stringify(revenueSnapshot(), null, 2));
  process.exit(0);
}

if (isMain) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        listening: `http://127.0.0.1:${PORT}`,
        streams: ["R01", "R02"],
        qmem: QMEM,
        ollama: OLLAMA,
      })
    );
  });
}

export { mintKey, revenueSnapshot, TIERS, loadKeys };
