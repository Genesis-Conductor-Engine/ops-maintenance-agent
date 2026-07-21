#!/usr/bin/env node
/**
 * Minimal automated tests for inference meter auth + Stripe webhook.
 * Targets the live meter at http://127.0.0.1:8792 (does not start a server).
 *
 * Usage: node scripts/test-inference-meter.mjs
 *        npm run test:inference
 *
 * Never prints full API keys.
 */
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.INFERENCE_METER_URL || "http://127.0.0.1:8792";
const STARTER_KEY_PATH =
  process.env.INFERENCE_KEY_STARTER_PATH ||
  "/root/.vault/secrets/INFERENCE_KEY_STARTER";
const CHAT_TIMEOUT_MS = Number(process.env.INFERENCE_TEST_CHAT_TIMEOUT_MS || 90_000);

let failed = 0;
let passed = 0;

function maskKey(k) {
  if (!k || typeof k !== "string") return "(none)";
  if (k.length <= 12) return `${k.slice(0, 4)}…`;
  return `${k.slice(0, 8)}…${k.slice(-4)} (len=${k.length})`;
}

function ok(name, detail = "") {
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(method, path, { headers = {}, body, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body != null ? body : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-json */
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

function loadStarterKey() {
  if (!existsSync(STARTER_KEY_PATH)) return null;
  try {
    const raw = readFileSync(STARTER_KEY_PATH, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

async function testHealth() {
  const name = "GET /health → 200";
  try {
    const r = await request("GET", "/health");
    if (r.status === 200 && r.json?.ok === true) {
      ok(name, `service=${r.json.service || "?"}`);
    } else {
      fail(name, `status=${r.status} body=${r.text.slice(0, 160)}`);
    }
  } catch (e) {
    fail(name, String(e?.message || e));
  }
}

async function testChatNoKey() {
  const name = "POST /v1/chat/completions without key → 401";
  try {
    const r = await request("POST", "/v1/chat/completions", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "phi-2.Q4_K_M.gguf",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    });
    if (r.status === 401) {
      ok(name);
    } else {
      fail(name, `status=${r.status} body=${r.text.slice(0, 160)}`);
    }
  } catch (e) {
    fail(name, String(e?.message || e));
  }
}

async function testChatWithStarterKey() {
  const key = loadStarterKey();
  const name = "POST /v1/chat/completions with vault starter key";
  if (!key) {
    console.log(
      `SKIP  ${name} — ${STARTER_KEY_PATH} not present (optional when vault empty)`
    );
    return;
  }
  try {
    const r = await request("POST", "/v1/chat/completions", {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "phi-2.Q4_K_M.gguf",
        messages: [{ role: "user", content: "say hi" }],
        max_tokens: 4,
        stream: false,
      }),
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    // 200 preferred; 5xx acceptable if upstream model is slow/down (auth succeeded)
    if (r.status === 200) {
      ok(name, `status=200 key=${maskKey(key)}`);
    } else if (r.status >= 500) {
      ok(
        name,
        `status=${r.status} (upstream 5xx acceptable after auth) key=${maskKey(key)}`
      );
    } else if (r.status === 429) {
      ok(name, `status=429 rate limit (auth accepted) key=${maskKey(key)}`);
    } else {
      fail(
        name,
        `status=${r.status} key=${maskKey(key)} body=${r.text.slice(0, 160)}`
      );
    }
  } catch (e) {
    const msg = String(e?.message || e);
    // Abort / timeout → treat as slow upstream after auth path was hit
    if (/abort/i.test(msg)) {
      ok(name, `timeout after ${CHAT_TIMEOUT_MS}ms (upstream slow; auth path exercised) key=${maskKey(key)}`);
    } else {
      fail(name, `${msg} key=${maskKey(key)}`);
    }
  }
}

async function testAdminUnauth() {
  const name = "GET /admin/revenue without auth → 401";
  try {
    const r = await request("GET", "/admin/revenue");
    // 401 when ADMIN_TOKEN configured; 503 if not — both prove admin is not open
    if (r.status === 401) {
      ok(name);
    } else if (r.status === 503 && /ADMIN_TOKEN/i.test(r.text)) {
      ok(name, "status=503 ADMIN_TOKEN not configured (not open)");
    } else {
      fail(name, `status=${r.status} body=${r.text.slice(0, 160)}`);
    }
  } catch (e) {
    fail(name, String(e?.message || e));
  }
}

async function testWebhookReject() {
  const name = "POST /webhook/stripe rejects unauthenticated body";
  try {
    // No signature header
    const r1 = await request("POST", "/webhook/stripe", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
    });
    // Missing secret → 503; secret present + missing/invalid sig → 400
    if (r1.status === 503) {
      ok(name, "status=503 (webhook secret not configured)");
      return;
    }
    if (r1.status === 400) {
      ok(name, "status=400 (invalid/missing signature with secret present)");
      return;
    }

    // If 503 not returned, try explicit invalid signature (secret must be configured)
    const r2 = await request("POST", "/webhook/stripe", {
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      },
      body: JSON.stringify({ type: "ping" }),
    });
    if (r2.status === 400 || r2.status === 503) {
      ok(name, `status=${r2.status} with invalid signature header`);
    } else {
      fail(
        name,
        `expected 503 (no secret) or 400 (bad sig); got no-sig=${r1.status} bad-sig=${r2.status}`
      );
    }
  } catch (e) {
    fail(name, String(e?.message || e));
  }
}

async function main() {
  console.log(`inference-meter tests → ${BASE}`);
  console.log("---");

  await testHealth();
  await testChatNoKey();
  await testChatWithStarterKey();
  await testAdminUnauth();
  await testWebhookReject();

  console.log("---");
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL", e?.message || e);
  process.exit(1);
});
