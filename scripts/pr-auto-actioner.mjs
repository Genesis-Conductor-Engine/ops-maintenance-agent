#!/usr/bin/env node
/**
 * Auto-action agent for watched PRs (Genesis-Conductor-Engine org).
 *
 * Safe autonomous actions only (no merge):
 *  1) gh pr update-branch  — resolve behind-base / some conflicts when clean
 *  2) gh run rerun --failed — re-trigger failed CI once per PR per day
 *  3) comment summary when blocked for human/worktree fix
 *
 * Heavier code fixes go through /pr-babysit worktree subagents.
 *
 * Triggers:
 *  - CLI: node scripts/pr-auto-actioner.mjs [--max N] [--dry-run]
 *  - HTTP: POST /ops/pr-auto-action  (ops-http-server)
 *  - systemd timer: ops-pr-auto-action.timer
 */
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/root";
const STATE_DIR = join(HOME, ".grok/plugin-data/pr-babysit");
const ACTION_STATE = join(STATE_DIR, "auto-action-state.json");
const REPORTS = join(
  process.env.OPS_ROOT || "/root/ops-maintenance-agent",
  "reports"
);
const MAX_DEFAULT = Number(process.env.PR_AUTO_MAX || 24);
const ACTIONABLE = new Set([
  "ci_failed",
  "conflicts",
  "changes_requested",
  "review_comments",
]);

function sh(bin, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(bin, args, {
        encoding: "utf8",
        timeout: opts.timeout ?? 120_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", PATH: process.env.PATH },
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function loadWatchlist() {
  if (!existsSync(STATE_DIR)) return [];
  const files = readdirSync(STATE_DIR)
    .filter((f) => f.startsWith("watched-prs-") && f.endsWith(".json"))
    .map((f) => join(STATE_DIR, f));
  if (!files.length) return [];
  // Prefer largest / most recent inventory
  files.sort((a, b) => {
    try {
      const sa = JSON.parse(readFileSync(a, "utf8"));
      const sb = JSON.parse(readFileSync(b, "utf8"));
      return (sb.prs?.length || 0) - (sa.prs?.length || 0);
    } catch {
      return 0;
    }
  });
  try {
    const d = JSON.parse(readFileSync(files[0], "utf8"));
    return d.prs || [];
  } catch {
    return [];
  }
}

function loadActionState() {
  if (!existsSync(ACTION_STATE)) return { actions: {}, history: [] };
  try {
    return JSON.parse(readFileSync(ACTION_STATE, "utf8"));
  } catch {
    return { actions: {}, history: [] };
  }
}

function saveActionState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACTION_STATE, JSON.stringify(state, null, 2));
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function prKey(pr) {
  return `${pr.repo}#${pr.number}`;
}

function prioritize(prs) {
  const weight = {
    conflicts: 0,
    changes_requested: 1,
    review_comments: 2,
    ci_failed: 3,
  };
  // Prefer non-mass-seismic-log noise and non-pure chore deps slightly lower
  return [...prs].sort((a, b) => {
    const wa = weight[a.last_status] ?? 9;
    const wb = weight[b.last_status] ?? 9;
    if (wa !== wb) return wa - wb;
    const ra = (a.repo || "").includes("genesis-seismic-log") ? 1 : 0;
    const rb = (b.repo || "").includes("genesis-seismic-log") ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return (b.number || 0) - (a.number || 0);
  });
}

function updateBranch(repo, number) {
  return sh(
    "gh",
    ["pr", "update-branch", String(number), "--repo", repo],
    { timeout: 180_000 }
  );
}

function latestFailedRun(repo, headRef) {
  const r = sh("gh", [
    "run",
    "list",
    "--repo",
    repo,
    "--branch",
    headRef,
    "--status",
    "failure",
    "--limit",
    "1",
    "--json",
    "databaseId,name,conclusion,headBranch,url",
  ]);
  if (!r.ok || !r.out) return null;
  try {
    const arr = JSON.parse(r.out);
    return arr[0] || null;
  } catch {
    return null;
  }
}

function rerunFailed(repo, runId) {
  return sh(
    "gh",
    ["run", "rerun", String(runId), "--repo", repo, "--failed"],
    { timeout: 60_000 }
  );
}

function comment(repo, number, body) {
  return sh(
    "gh",
    ["pr", "comment", String(number), "--repo", repo, "--body", body],
    { timeout: 30_000 }
  );
}

/**
 * @param {{ max?: number, dryRun?: boolean }} opts
 */
export function runPrAutoAction(opts = {}) {
  const max = opts.max ?? MAX_DEFAULT;
  const dryRun = Boolean(opts.dryRun);
  const started = new Date().toISOString();
  const watch = loadWatchlist();
  const actionable = prioritize(
    watch.filter((p) => ACTIONABLE.has(p.last_status))
  );
  const state = loadActionState();
  const today = dayKey();
  const results = [];
  let acted = 0;

  for (const pr of actionable) {
    if (acted >= max) break;
    const key = prKey(pr);
    const prior = state.actions[key] || {};
    const entry = {
      key,
      repo: pr.repo,
      number: pr.number,
      status: pr.last_status,
      branch: pr.branch,
      actions: [],
      ok: false,
    };

    // --- conflicts / behind: try update-branch ---
    if (pr.last_status === "conflicts" || pr.last_status === "ci_failed") {
      if (prior.update_branch_day === today && pr.last_status === "conflicts") {
        entry.actions.push({ type: "update-branch", skipped: "already today" });
      } else if (!dryRun) {
        const u = updateBranch(pr.repo, pr.number);
        entry.actions.push({
          type: "update-branch",
          ok: u.ok,
          detail: u.out.slice(0, 300),
        });
        if (u.ok) {
          prior.update_branch_day = today;
          acted += 1;
        }
      } else {
        entry.actions.push({ type: "update-branch", dryRun: true });
        acted += 1;
      }
    }

    // --- ci_failed: rerun failed workflow once/day ---
    if (pr.last_status === "ci_failed" && pr.branch) {
      if (prior.rerun_day === today) {
        entry.actions.push({ type: "rerun-failed", skipped: "already today" });
      } else {
        const run = latestFailedRun(pr.repo, pr.branch);
        if (!run) {
          entry.actions.push({ type: "rerun-failed", skipped: "no failed run" });
        } else if (!dryRun) {
          const rr = rerunFailed(pr.repo, run.databaseId);
          entry.actions.push({
            type: "rerun-failed",
            ok: rr.ok,
            runId: run.databaseId,
            detail: rr.out.slice(0, 300),
          });
          if (rr.ok) {
            prior.rerun_day = today;
            acted += 1;
          }
        } else {
          entry.actions.push({
            type: "rerun-failed",
            dryRun: true,
            runId: run.databaseId,
          });
          acted += 1;
        }
      }
    }

    // --- changes_requested: leave for worktree subagent; stamp once ---
    if (
      (pr.last_status === "changes_requested" ||
        pr.last_status === "review_comments") &&
      prior.noted_day !== today
    ) {
      if (!dryRun && !prior.noted_day) {
        const c = comment(
          pr.repo,
          pr.number,
          "Automated triage: queued for worktree `/pr-babysit` fix agent (code change required)."
        );
        entry.actions.push({ type: "queue-comment", ok: c.ok });
        prior.noted_day = today;
        if (c.ok) acted += 1;
      } else {
        entry.actions.push({ type: "queue-comment", dryRun: dryRun || Boolean(prior.noted_day) });
      }
    }

    entry.ok = entry.actions.some((a) => a.ok);
    state.actions[key] = { ...prior, last_seen: started, last_status: pr.last_status };
    results.push(entry);
  }

  state.history = [
    {
      at: started,
      dryRun,
      max,
      candidates: actionable.length,
      processed: results.length,
      acted,
    },
    ...(state.history || []).slice(0, 49),
  ];
  if (!dryRun) saveActionState(state);

  const report = {
    at: started,
    dryRun,
    candidates: actionable.length,
    processed: results.length,
    acted,
    results: results.filter((r) => r.actions.length),
    note: "Auto-actions: update-branch + CI rerun only. Code fixes via worktree subagents.",
  };

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, "pr-auto-action-latest.json"), JSON.stringify(report, null, 2));
  return report;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pr-auto-actioner.mjs");

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let max = MAX_DEFAULT;
  const mi = args.indexOf("--max");
  if (mi >= 0) max = Number(args[mi + 1]) || max;
  const report = runPrAutoAction({ max, dryRun });
  console.log(
    JSON.stringify(
      {
        at: report.at,
        candidates: report.candidates,
        processed: report.processed,
        acted: report.acted,
        sample: report.results.slice(0, 12),
      },
      null,
      2
    )
  );
  process.exit(0);
}
