#!/usr/bin/env node
/**
 * R01/R02 metered OpenAI-compatible inference gateway.
 *
 * - API key auth (Bearer sk_... or X-API-Key)
 * - Proxies to q-mem (primary :8082) then ollama (:11434)
 * - Meters tokens + requests in Redis
 * - Pricing tiers for cashflow pipeline / invoices
 * - Stripe checkout fulfillment (webhook → mint key + cashflow)
 *
 * Endpoints:
 *   GET  /health
 *   GET  /pricing
 *   GET  /issued-key?session_id=
 *   POST /webhook/stripe
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *   POST /v1/completions
 *   POST /admin/keys          (requires ADMIN_TOKEN)
 *   GET  /admin/usage?key=   (requires ADMIN_TOKEN)
 *   GET  /admin/revenue      (requires ADMIN_TOKEN)
 */
import http from "node:http";
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordCashflow } from "./cashflow-ledger.mjs";

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
/** Stripe webhook signing secret (whsec_…). Always required to accept webhooks. */
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
/** Local-only: widen signature timestamp tolerance for vaulted/dev HMAC tests. */
const WEBHOOK_DEV = process.env.INFERENCE_WEBHOOK_DEV === "1";
const CHECKOUT_URLS = {
  starter: process.env.STRIPE_CHECKOUT_STARTER_URL || null,
  pro: process.env.STRIPE_CHECKOUT_PRO_URL || null,
  enterprise: process.env.STRIPE_CHECKOUT_ENTERPRISE_URL || null,
};
const REDIS_PREFIX = "diamondnode:inference:";
const KEYS_REDIS = `${REDIS_PREFIX}keys`;
const USAGE_REDIS = `${REDIS_PREFIX}usage:`;
const SESSIONS_REDIS = `${REDIS_PREFIX}sessions`;
const LOCAL_KEYS = join(REPORTS, "inference-keys.json");
const LOCAL_SESSIONS = join(REPORTS, "inference-sessions.json");
/** How long a minted key remains redeemable via /issued-key (ms). */
const ISSUED_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** Stripe amount_total (cents) → tier when metadata.tier absent. */
const AMOUNT_TIER_CENTS = {
  2900: "starter",
  14900: "pro",
  99900: "enterprise",
};

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

function loadSessionsDisk() {
  mkdirSync(REPORTS, { recursive: true });
  if (!existsSync(LOCAL_SESSIONS)) return { sessions: {} };
  try {
    return JSON.parse(readFileSync(LOCAL_SESSIONS, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function saveSessionsDisk(store) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(LOCAL_SESSIONS, JSON.stringify(store, null, 2));
  redis(["SET", SESSIONS_REDIS, JSON.stringify(store)]);
}

function loadSessions() {
  const raw = redis(["GET", SESSIONS_REDIS]);
  if (raw && raw !== "(nil)") {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  return loadSessionsDisk();
}

/**
 * Persist Stripe checkout session → issued key mapping (Redis + disk).
 * Full key stored only until first redeem or TTL expiry; never log raw key.
 */
function storeIssuedSession(entry) {
  const store = loadSessions();
  store.sessions = store.sessions || {};
  store.sessions[entry.session_id] = entry;
  saveSessionsDisk(store);
  return entry;
}

function getIssuedSession(sessionId) {
  if (!sessionId) return null;
  const store = loadSessions();
  return store.sessions?.[sessionId] || null;
}

function patchIssuedSession(sessionId, patch) {
  const store = loadSessions();
  const cur = store.sessions?.[sessionId];
  if (!cur) return null;
  store.sessions[sessionId] = { ...cur, ...patch };
  saveSessionsDisk(store);
  return store.sessions[sessionId];
}

/** Map checkout session amount/metadata → paid tier id. */
function tierFromCheckoutSession(session) {
  const metaTier = session?.metadata?.tier || session?.metadata?.plan;
  if (metaTier && TIERS[metaTier] && metaTier !== "free") return metaTier;
  const cents = Number(session?.amount_total);
  if (Number.isFinite(cents) && AMOUNT_TIER_CENTS[cents]) {
    return AMOUNT_TIER_CENTS[cents];
  }
  // line_items not expanded on basic session; fall back starter if paid
  if (session?.payment_status === "paid" || session?.status === "complete") {
    return "starter";
  }
  return null;
}

/**
 * Verify Stripe-Signature header (t=…,v1=…).
 * Uses raw body string; secret is STRIPE_WEBHOOK_SECRET.
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyStripeSignature(rawBody, sigHeader, secret, opts = {}) {
  const toleranceSec = opts.toleranceSec ?? (WEBHOOK_DEV ? 86400 : 300);
  if (!secret) return { ok: false, reason: "webhook_secret_missing" };
  if (!sigHeader) return { ok: false, reason: "signature_header_missing" };
  const items = String(sigHeader).split(",").map((p) => p.trim());
  let timestamp = null;
  const v1s = [];
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const k = item.slice(0, eq);
    const v = item.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") v1s.push(v);
  }
  if (!timestamp || v1s.length === 0) {
    return { ok: false, reason: "signature_malformed" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp_invalid" };
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > toleranceSec) return { ok: false, reason: "timestamp_outside_tolerance" };

  const signed = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signed, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  let match = false;
  for (const sig of v1s) {
    const got = Buffer.from(sig, "utf8");
    if (got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf)) {
      match = true;
      break;
    }
  }
  if (!match) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Fulfill checkout.session.completed: mint tier key, map session, book cashflow.
 * Idempotent on session_id. Never logs full API key — only id/prefix.
 */
function fulfillCheckoutSession(session) {
  const sessionId = session?.id;
  if (!sessionId) throw new Error("checkout session missing id");

  const existing = getIssuedSession(sessionId);
  if (existing?.fulfilled) {
    return {
      status: "already_fulfilled",
      session_id: sessionId,
      key_id: existing.key_id,
      tier: existing.tier,
      prefix: existing.prefix,
    };
  }

  const tier = tierFromCheckoutSession(session);
  if (!tier || !TIERS[tier] || tier === "free") {
    throw new Error(`unable to resolve paid tier for session ${sessionId}`);
  }
  const email =
    session.customer_details?.email ||
    session.customer_email ||
    session.metadata?.email ||
    null;
  const label = email ? `stripe:${email}` : `stripe:${sessionId.slice(0, 16)}`;
  const minted = mintKey(tier, label);
  const priceMo = TIERS[tier].price_mo || 0;
  const now = new Date().toISOString();

  storeIssuedSession({
    session_id: sessionId,
    key_id: minted.meta.id,
    prefix: minted.meta.prefix,
    // held for success-page redeem for ISSUED_KEY_TTL_MS; never logged in full
    key_raw: minted.raw,
    tier,
    price_mo: priceMo,
    customer_email: email,
    stripe_customer: session.customer || null,
    amount_total: session.amount_total ?? null,
    currency: session.currency || "usd",
    fulfilled: true,
    created_at: now,
    expires_at: new Date(Date.now() + ISSUED_KEY_TTL_MS).toISOString(),
    retrieved_at: null,
    cashflow_recorded: false,
  });

  try {
    recordCashflow("R01", {
      delta_mrr: priceMo,
      delta_cash: priceMo,
      note: `stripe session ${sessionId} tier=${tier} key_id=${minted.meta.id}`,
    });
    patchIssuedSession(sessionId, { cashflow_recorded: true });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "cashflow_record_failed",
        session_id: sessionId,
        key_id: minted.meta.id,
        error: String(e?.message || e),
      })
    );
  }

  console.log(
    JSON.stringify({
      event: "stripe_checkout_fulfilled",
      session_id: sessionId,
      key_id: minted.meta.id,
      prefix: minted.meta.prefix,
      tier,
      price_mo: priceMo,
      has_email: Boolean(email),
    })
  );

  return {
    status: "fulfilled",
    session_id: sessionId,
    key_id: minted.meta.id,
    tier,
    prefix: minted.meta.prefix,
    price_mo: priceMo,
  };
}

async function handleStripeWebhook(req, res) {
  // Production: require secret. Dev mode (INFERENCE_WEBHOOK_DEV=1) still needs a secret
  // for HMAC but may use a vaulted/dev value for local tests.
  if (!STRIPE_WEBHOOK_SECRET) {
    return json(res, 503, {
      error: "STRIPE_WEBHOOK_SECRET not configured",
      message:
        "Unsigned Stripe webhooks are rejected. Set STRIPE_WEBHOOK_SECRET in vault env" +
        (WEBHOOK_DEV
          ? " (INFERENCE_WEBHOOK_DEV=1 allows local HMAC with a test secret)."
          : "."),
      dev_mode: WEBHOOK_DEV,
    });
  }

  const rawBody = await readRawBody(req);
  const sigHeader = req.headers["stripe-signature"] || "";
  const verified = verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook_reject",
        reason: verified.reason,
      })
    );
    return json(res, 400, {
      error: "invalid_signature",
      reason: verified.reason,
    });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }

  const type = event?.type || "";
  if (type !== "checkout.session.completed") {
    // Ack other event types so Stripe does not retry.
    return json(res, 200, { received: true, ignored: type || "unknown" });
  }

  const session = event?.data?.object;
  if (!session || session.object !== "checkout.session") {
    return json(res, 400, { error: "missing_checkout_session" });
  }

  try {
    const result = fulfillCheckoutSession(session);
    return json(res, 200, {
      received: true,
      ...result,
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "stripe_fulfill_error",
        error: String(e?.message || e),
      })
    );
    return json(res, 500, { error: String(e?.message || e) });
  }
}

function handleIssuedKey(url, res) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return json(res, 400, { error: "session_id required" });
  }
  const entry = getIssuedSession(sessionId);
  if (!entry || !entry.fulfilled) {
    return json(res, 404, { error: "session not found or not fulfilled" });
  }

  const expired =
    entry.expires_at && new Date(entry.expires_at).getTime() < Date.now();
  if (expired) {
    if (entry.key_raw) patchIssuedSession(sessionId, { key_raw: null });
    return json(res, 410, {
      error: "key_expired",
      message: "API key redeem window (24h) has elapsed. Contact support with session_id.",
      session_id: sessionId,
      key_id: entry.key_id,
      prefix: entry.prefix,
      tier: entry.tier,
    });
  }

  // One-time reveal preferred; if already retrieved, still allow until TTL for success-page reloads
  // but do not re-persist raw if already cleared.
  const raw = entry.key_raw || null;
  if (!raw) {
    return json(res, 410, {
      error: "key_already_redeemed",
      message: "Full API key was already issued and is no longer stored. Use the key you saved.",
      session_id: sessionId,
      key_id: entry.key_id,
      prefix: entry.prefix,
      tier: entry.tier,
    });
  }

  const first = !entry.retrieved_at;
  patchIssuedSession(sessionId, {
    retrieved_at: entry.retrieved_at || new Date().toISOString(),
    // Clear raw after first successful redeem to limit exposure (still within 24h window for retries?
    // Spec: "return key once (or 24h)". Keep raw until TTL; mark retrieved.
  });

  return json(res, 200, {
    session_id: sessionId,
    key: raw,
    key_id: entry.key_id,
    prefix: entry.prefix,
    tier: entry.tier,
    price_mo: entry.price_mo,
    first_retrieve: first,
    expires_at: entry.expires_at,
    warning: "Store this key now; it is not re-shown after the redeem window.",
  });
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
      const checkout = {
        starter: CHECKOUT_URLS.starter,
        pro: CHECKOUT_URLS.pro,
        enterprise: CHECKOUT_URLS.enterprise,
      };
      const anyCheckout = Object.values(checkout).some(Boolean);
      return json(res, 200, {
        currency: "USD",
        stream: "R01",
        story: "Sovereign LLM Inference API on diamondnode (q-mem + ollama dual-backend)",
        pricing: TIERS,
        checkout,
        checkout_ready: anyCheckout,
        checkout_note: anyCheckout
          ? "Use checkout URLs for the desired tier; after payment your API key is available at GET /issued-key?session_id=…"
          : "Stripe Payment Links not configured yet (set STRIPE_CHECKOUT_STARTER_URL / PRO / ENTERPRISE). Contact sales or use Genesis Conductor billing portal.",
        webhook: "/webhook/stripe",
        issued_key: "/issued-key?session_id=",
      });
    }

    if (req.method === "GET" && url.pathname === "/issued-key") {
      return handleIssuedKey(url, res);
    }

    if (req.method === "POST" && url.pathname === "/webhook/stripe") {
      return handleStripeWebhook(req, res);
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
        "GET /issued-key?session_id=",
        "POST /webhook/stripe",
        "GET /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/completions",
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

export {
  mintKey,
  revenueSnapshot,
  TIERS,
  loadKeys,
  verifyStripeSignature,
  fulfillCheckoutSession,
  tierFromCheckoutSession,
  AMOUNT_TIER_CENTS,
};
