#!/usr/bin/env node
/**
 * Temporal-compatible activity entrypoint (also runnable standalone).
 * Wire from gc-workers/temporal as an activity:
 *   import { runPrAutoAction } from '.../pr-auto-actioner.mjs'
 *
 * Env:
 *   TEMPORAL_TASK_QUEUE=pr-auto-action (optional documentation)
 *   PR_AUTO_MAX=32
 */
import { runPrAutoAction } from "./pr-auto-actioner.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export async function prAutoActionActivity(input = {}) {
  const report = runPrAutoAction({
    max: input.max ?? Number(process.env.PR_AUTO_MAX || 32),
    dryRun: Boolean(input.dryRun),
  });
  return {
    acted: report.acted,
    processed: report.processed,
    candidates: report.candidates,
    at: report.at,
  };
}

// Standalone / cron alias
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pr-auto-action-temporal-activity.mjs")
) {
  prAutoActionActivity({}).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pr-auto-action-activity.json"), JSON.stringify(r, null, 2));
  });
}
