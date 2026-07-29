#!/usr/bin/env node
/**
 * Stripe vault + webhook setup for R01 inference meter.
 *
 * Modes:
 *  1) status  — report vault presence + public endpoint probe (default)
 *  2) install — write STRIPE_WEBHOOK_SECRET from env/file (never invents secrets)
 *  3) register — if STRIPE_SECRET_KEY present, create Dashboard webhook endpoint
 *                and vault the returned signing secret
 *
 * Usage:
 *   node scripts/stripe-vault-webhook-setup.mjs status
 *   STRIPE_WEBHOOK_SECRET=whsec_… node scripts/stripe-vault-webhook-setup.mjs install
 *   STRIPE_SECRET_KEY=sk_… node scripts/stripe-vault-webhook-setup.mjs register
 */
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const VAULT_SECRETS = "/root/.vault/secrets";
const VAULT_ENV = "/root/.vault/env/agent.env";
const SECRET_PATH = join(VAULT_SECRETS, "STRIPE_WEBHOOK_SECRET");
const WEBHOOK_URL =
  process.env.STRIPE_WEBHOOK_URL ||
  "https://inference.yennefer.quest/webhook/stripe";
const EVENTS = ["checkout.session.completed"];

function readVault(name) {
  const p = join(VAULT_SECRETS, name);
  if (existsSync(p)) {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      /* ignore */
    }
  }
  if (existsSync(VAULT_ENV)) {
    try {
      for (const line of readFileSync(VAULT_ENV, "utf8").split("\n")) {
        const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
        if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
      }
    } catch {
      /* ignore */
    }
  }
  return process.env[name] || "";
}

function writeVaultSecret(name, value) {
  mkdirSync(VAULT_SECRETS, { recursive: true });
  const p = join(VAULT_SECRETS, name);
  writeFileSync(p, value + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  mkdirSync(join(VAULT_ENV, ".."), { recursive: true });
  let env = existsSync(VAULT_ENV) ? readFileSync(VAULT_ENV, "utf8") : "";
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  const line = `${name}=${value}`;
  if (re.test(env)) env = env.replace(re, line);
  else env = env.replace(/\s*$/, "") + (env ? "\n" : "") + line + "\n";
  writeFileSync(VAULT_ENV, env, { mode: 0o600 });
  chmodSync(VAULT_ENV, 0o600);
  return p;
}

function probeWebhook() {
  try {
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "-m",
        "8",
        "-X",
        "POST",
        WEBHOOK_URL,
        "-H",
        "content-type: application/json",
        "-d",
        "{}",
      ],
      { encoding: "utf8" }
    );
    return { ok: true, body: out.slice(0, 500) };
  } catch (e) {
    return {
      ok: false,
      body: (e.stdout || e.stderr || e.message || String(e)).toString().slice(0, 500),
    };
  }
}

function restartMeter() {
  try {
    execFileSync("systemctl", ["restart", "ops-inference-meter.service"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function cmdStatus() {
  const secret = readVault("STRIPE_WEBHOOK_SECRET");
  const sk = readVault("STRIPE_SECRET_KEY");
  const checkout = {
    starter: Boolean(readVault("STRIPE_CHECKOUT_STARTER_URL")),
    pro: Boolean(readVault("STRIPE_CHECKOUT_PRO_URL")),
    enterprise: Boolean(readVault("STRIPE_CHECKOUT_ENTERPRISE_URL")),
  };
  const probe = probeWebhook();
  const report = {
    at: new Date().toISOString(),
    webhook_url: WEBHOOK_URL,
    vault: {
      STRIPE_WEBHOOK_SECRET: Boolean(secret),
      STRIPE_SECRET_KEY: Boolean(sk),
      checkout_urls: checkout,
    },
    probe,
    next: !secret
      ? [
          "Dashboard → Developers → Webhooks → Add endpoint",
          `URL: ${WEBHOOK_URL}`,
          "Events: checkout.session.completed",
          "Copy Signing secret (whsec_…)",
          "STRIPE_WEBHOOK_SECRET=whsec_… node scripts/stripe-vault-webhook-setup.mjs install",
          "Or: STRIPE_SECRET_KEY=sk_… node scripts/stripe-vault-webhook-setup.mjs register",
        ]
      : ["Webhook secret present — send test event from Stripe Dashboard"],
  };
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(
    join(ROOT, "reports", "stripe-vault-status.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(secret ? 0 : 2);
}

function cmdInstall() {
  const secret =
    process.env.STRIPE_WEBHOOK_SECRET ||
    (process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : "");
  if (!secret || !secret.startsWith("whsec_")) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "STRIPE_WEBHOOK_SECRET required (must start with whsec_)",
        hint: "STRIPE_WEBHOOK_SECRET=whsec_… node scripts/stripe-vault-webhook-setup.mjs install",
      })
    );
    process.exit(2);
  }
  const path = writeVaultSecret("STRIPE_WEBHOOK_SECRET", secret);
  const restart = restartMeter();
  const probe = probeWebhook();
  console.log(
    JSON.stringify({
      ok: true,
      vault_path: path,
      restart,
      probe,
      note: "Secret value never logged",
    })
  );
  process.exit(0);
}

async function cmdRegister() {
  const sk = readVault("STRIPE_SECRET_KEY");
  if (!sk || !sk.startsWith("sk_")) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "STRIPE_SECRET_KEY missing (sk_live_… or sk_test_…)",
        hint: "Install API key in vault, then re-run register",
      })
    );
    process.exit(2);
  }
  const body = new URLSearchParams();
  body.set("url", WEBHOOK_URL);
  body.set("description", "R01 inference meter checkout.session.completed");
  for (const e of EVENTS) body.append("enabled_events[]", e);

  const res = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: {
      authorization: `Bearer ${sk}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, http: res.status, data }));
    process.exit(1);
  }
  const secret = data.secret;
  if (!secret) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Stripe returned endpoint without secret (already exists?)",
        id: data.id,
        url: data.url,
      })
    );
    process.exit(1);
  }
  writeVaultSecret("STRIPE_WEBHOOK_SECRET", secret);
  if (data.id) writeVaultSecret("STRIPE_WEBHOOK_ENDPOINT_ID", data.id);
  const restart = restartMeter();
  console.log(
    JSON.stringify({
      ok: true,
      endpoint_id: data.id,
      url: data.url,
      status: data.status,
      restart,
      note: "Signing secret vaulted; value not printed",
    })
  );
  process.exit(0);
}

const cmd = process.argv[2] || "status";
if (cmd === "status") cmdStatus();
else if (cmd === "install") cmdInstall();
else if (cmd === "register") cmdRegister().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(1);
});
else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}
