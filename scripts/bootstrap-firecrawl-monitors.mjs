#!/usr/bin/env node
/**
 * Create Firecrawl monitors from monitors/goal-firecrawl-monitors.json.
 * Requires FIRECRAWL_API_KEY (or firecrawl login).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(ROOT, "monitors", "goal-firecrawl-monitors.json");
const STATE = join(ROOT, "reports", "firecrawl-monitors-state.json");

function loadKey() {
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY;
  for (const p of [
    "/root/.vault/secrets/FIRECRAWL_API_KEY",
    join(ROOT, ".vault", "secrets", "FIRECRAWL_API_KEY"),
  ]) {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  return "";
}

function createViaApi(mon, key) {
  const body = {
    name: mon.name,
    goal: mon.goal,
    schedule: { text: mon.scheduleText || "every 6 hours", timezone: "UTC" },
    targets: [
      {
        type: "search",
        queries: mon.queries,
        searchWindow: mon.searchWindow || "24h",
        maxResults: mon.maxResults || 10,
      },
    ],
  };
  const res = execFileSync(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      "https://api.firecrawl.dev/v2/monitors",
      "-H",
      `Authorization: Bearer ${key}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    ],
    { encoding: "utf8", timeout: 60_000 }
  );
  return JSON.parse(res);
}

function main() {
  const key = loadKey();
  if (!key) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "FIRECRAWL_API_KEY missing",
        hint: "export FIRECRAWL_API_KEY=fc-... or store in /root/.vault/secrets/FIRECRAWL_API_KEY",
        monitors_spec: SPEC,
      })
    );
    process.exit(2);
  }

  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const results = [];
  for (const mon of spec.monitors || []) {
    try {
      const out = createViaApi(mon, key);
      results.push({ name: mon.name, stream: mon.stream, ok: true, out });
      console.log(`[monitor] created ${mon.name}`);
    } catch (e) {
      results.push({
        name: mon.name,
        stream: mon.stream,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      console.error(`[monitor] FAIL ${mon.name}:`, e.message || e);
    }
  }

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const state = {
    at: new Date().toISOString(),
    results,
    ok: results.every((r) => r.ok),
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: state.ok, count: results.length, state: STATE }));
  process.exit(state.ok ? 0 : 1);
}

main();
