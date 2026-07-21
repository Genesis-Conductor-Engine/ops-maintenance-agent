#!/usr/bin/env node
/**
 * Run procedural truth verifier on diamondnode (q-mem + Ollama loopback).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PTV =
  process.env.PTV_SCRIPT ||
  "/home/diamondnode/genesis_conductor_engine/swarm/procedural_truth_verifier.py";
const SOURCE = process.env.PTV_SOURCE || "ops-loop";

function main() {
  const out = execFileSync(
    "python3",
    [PTV, "--source", SOURCE, "--json"],
    {
      encoding: "utf8",
      timeout: 60_000,
      cwd: "/home/diamondnode/genesis_conductor_engine/swarm",
    }
  );
  const evt = JSON.parse(out);
  const cs = evt.crystal_score || {};
  const summary = {
    ok: Boolean(cs.passed),
    evt_id: evt.evt_id,
    crystal_value: cs.value,
    components: cs.components,
    at: new Date().toISOString(),
  };
  mkdirSync(join(process.cwd(), "reports"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "reports", "procedural-truth-latest.json"),
    JSON.stringify({ summary, evt }, null, 2)
  );
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

main();