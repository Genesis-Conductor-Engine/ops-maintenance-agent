#!/usr/bin/env node
/**
 * PR babysit inventory + state file for /pr-babysit all.
 * Full fix cycles require gh auth + repo context; this registers open PRs
 * and produces a status payload for the maintenance cycle.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const STATE_DIR = join(process.env.HOME || "/root", ".grok/plugin-data/pr-babysit");
const LOCAL_STATE = join(process.cwd(), "reports", "pr-babysit-state.json");

function sh(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || e.stderr || e.message || String(e)).toString().trim(),
    };
  }
}

function loadOrInitState() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(join(process.cwd(), "reports"), { recursive: true });

  if (existsSync(LOCAL_STATE)) {
    try {
      return JSON.parse(readFileSync(LOCAL_STATE, "utf8"));
    } catch {
      /* reset */
    }
  }

  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
    prs: [],
    groups: {},
    last_cycle: null,
    note: "pr-babysit state for ops-maintenance-agent",
  };
}

function persist(state) {
  writeFileSync(LOCAL_STATE, JSON.stringify(state, null, 2));
  const sessionPath = join(STATE_DIR, `watched-prs-${state.instance_id}.json`);
  writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  return sessionPath;
}

/**
 * Resolve which repos to inventory.
 * Precedence:
 *   1. GH_REPOS (comma-separated owner/name)
 *   2. GH_REPO (single owner/name)
 *   3. local `gh repo view` (cwd git remote)
 *   4. GH_OWNER or default Genesis-Conductor-Engine via `gh search prs`
 */
function resolveRepoTargets() {
  const multi = (process.env.GH_REPOS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) return { mode: "repos", repos: multi };

  if (process.env.GH_REPO) {
    return { mode: "repos", repos: [process.env.GH_REPO.trim()] };
  }

  const local = sh("gh repo view --json nameWithOwner --jq .nameWithOwner");
  if (local.ok && local.out) {
    return { mode: "repos", repos: [local.out] };
  }

  const owner =
    process.env.GH_OWNER ||
    process.env.GH_ORG ||
    "Genesis-Conductor-Engine";
  return { mode: "owner", owner };
}

function classifyPr(pr) {
  const failedChecks = (pr.statusCheckRollup || []).filter(
    (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR"
  );
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  if (failedChecks.length) return "ci_failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (
    (pr.statusCheckRollup || []).some(
      (c) => c.status === "IN_PROGRESS" || c.status === "QUEUED"
    )
  )
    return "pending";
  return "healthy";
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function listOpenPrsForRepo(repo) {
  const list = sh(
    `gh pr list --repo ${shellQuote(repo)} --state open --json number,title,headRefName,baseRefName,url,mergeable,statusCheckRollup,reviewDecision --limit 100`
  );
  if (!list.ok) return { ok: false, detail: list.out, prs: [] };
  try {
    return { ok: true, prs: JSON.parse(list.out || "[]") };
  } catch (e) {
    return { ok: false, detail: String(e), prs: [] };
  }
}

function listOpenPrsForOwner(owner) {
  // Search is lighter than cloning; statusCheckRollup not always present — enrich per-repo.
  const search = sh(
    `gh search prs --owner ${shellQuote(owner)} --state open --limit 50 --json repository,number,title,url,state`
  );
  if (!search.ok) return { ok: false, detail: search.out, items: [] };
  try {
    return { ok: true, items: JSON.parse(search.out || "[]") };
  } catch (e) {
    return { ok: false, detail: String(e), items: [] };
  }
}

export function runPrBabysitAll() {
  const state = loadOrInitState();
  const auth = sh("gh auth status");
  if (!auth.ok) {
    const result = {
      ok: false,
      blocked: "gh_auth",
      message:
        "BLOCKED: run `gh auth login` (or GH_TOKEN) before PR babysit can inventory/fix PRs",
      auth_detail: auth.out,
      watched: state.prs.length,
    };
    state.last_cycle = {
      at: new Date().toISOString(),
      result,
    };
    persist(state);
    return result;
  }

  const target = resolveRepoTargets();
  const now = new Date().toISOString();
  const existing = new Map(state.prs.map((p) => [`${p.repo}:${p.number}`, p]));
  const next = [];
  const reposSeen = new Set();
  const errors = [];

  if (target.mode === "repos") {
    for (const repo of target.repos) {
      reposSeen.add(repo);
      const { ok, prs, detail } = listOpenPrsForRepo(repo);
      if (!ok) {
        errors.push({ repo, detail });
        continue;
      }
      for (const pr of prs) {
        const key = `${repo}:${pr.number}`;
        const prev = existing.get(key);
        next.push({
          number: pr.number,
          repo,
          branch: pr.headRefName,
          base: pr.baseRefName,
          title: pr.title,
          url: pr.url,
          stack_id: null,
          stack_type: null,
          stack_position: 0,
          added_at: prev?.added_at || now,
          last_checked: now,
          last_status: classifyPr(pr),
          check_count: (prev?.check_count || 0) + 1,
          fix_count: prev?.fix_count || 0,
        });
      }
    }
  } else {
    // Owner-wide inventory: search, then enrich each hit with full PR JSON (checks).
    const { ok, items, detail } = listOpenPrsForOwner(target.owner);
    if (!ok) {
      const result = {
        ok: false,
        blocked: "list_failed",
        message: `BLOCKED: could not list open PRs for owner ${target.owner}`,
        detail,
      };
      state.last_cycle = { at: now, result };
      persist(state);
      return result;
    }

    // Group by repo so we only call gh pr list once per repo.
    const byRepo = new Map();
    for (const it of items) {
      const repo =
        it.repository?.nameWithOwner ||
        (it.repository?.owner && it.repository?.name
          ? `${it.repository.owner}/${it.repository.name}`
          : null);
      if (!repo) continue;
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(it.number);
    }

    for (const [repo] of byRepo) {
      reposSeen.add(repo);
      const { ok: rOk, prs, detail: rDetail } = listOpenPrsForRepo(repo);
      if (!rOk) {
        errors.push({ repo, detail: rDetail });
        continue;
      }
      for (const pr of prs) {
        const key = `${repo}:${pr.number}`;
        const prev = existing.get(key);
        next.push({
          number: pr.number,
          repo,
          branch: pr.headRefName,
          base: pr.baseRefName,
          title: pr.title,
          url: pr.url,
          stack_id: null,
          stack_type: null,
          stack_position: 0,
          added_at: prev?.added_at || now,
          last_checked: now,
          last_status: classifyPr(pr),
          check_count: (prev?.check_count || 0) + 1,
          fix_count: prev?.fix_count || 0,
        });
      }
    }
  }

  if (!next.length && errors.length && !reposSeen.size) {
    const result = {
      ok: false,
      blocked: "no_repo",
      message:
        "BLOCKED: not inside a git repo with GitHub remote. Set GH_REPO, GH_REPOS, or GH_OWNER.",
      detail: errors,
    };
    state.last_cycle = { at: now, result };
    persist(state);
    return result;
  }

  state.prs = next;
  state.groups = {};
  for (const p of next) {
    state.groups[`${p.repo}#${p.number}`] = {
      subagent_id: null,
      worktree_path: null,
    };
  }

  const actionable = next.filter((p) =>
    ["ci_failed", "conflicts", "changes_requested", "review_comments"].includes(
      p.last_status
    )
  );

  const repoLabel =
    target.mode === "owner"
      ? `owner:${target.owner}`
      : [...reposSeen].join(",");

  const result = {
    ok: true,
    repo: repoLabel,
    repos: [...reposSeen],
    watched: next.length,
    actionable: actionable.length,
    statuses: Object.fromEntries(
      next.map((p) => [`${p.repo}#${p.number}`, p.last_status])
    ),
    errors: errors.length ? errors : undefined,
    message:
      actionable.length === 0
        ? `All ${next.length} open PR(s) across ${reposSeen.size} repo(s) look healthy/pending — no fix dispatch needed`
        : `${actionable.length} PR(s) need attention — dispatch /pr-babysit check in Grok with worktree isolation`,
    prs: next.map((p) => ({
      number: p.number,
      repo: p.repo,
      status: p.last_status,
      title: p.title,
      url: p.url,
    })),
  };

  state.last_cycle = { at: now, result };
  const path = persist(state);
  result.state = path;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("pr-babysit.mjs")) {
  const result = runPrBabysitAll();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}
