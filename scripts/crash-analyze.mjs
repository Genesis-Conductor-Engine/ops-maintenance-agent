#!/usr/bin/env node
/**
 * Crash / post-reboot analysis for diamondnode.
 * Collects boot id, failed units, journal signals, disk, GPU — analysis only (no restarts).
 * Exit 0 always; severity is encoded in the report JSON.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Core services of interest for critical severity. */
const CORE_SERVICES = [
  "openclaw-gateway",
  "ollama",
  "nginx",
  "diamond-gateway",
  "redis-server",
  "qmem-llama-server",
  "qmem-sync",
  "genesis-ops-stream",
  "cloudflared",
  "ops-maintenance-http",
];

// Grep seeds — prefer specific phrases; classification uses stricter rules below.
const JOURNAL_PATTERNS = [
  "Out of memory",
  "oom-kill",
  "Killed process",
  "segfault at",
  "segfaulted",
  "general protection fault",
  "Kernel panic",
  "kernel panic",
  "Core dump",
  "core-dump",
  "Watchdog failed",
  "watchdog: BUG",
  "Failed with result",
  "oom_reaper",
  "Memory cgroup out of memory",
];

function sh(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        encoding: "utf8",
        timeout: opts.timeout ?? 30_000,
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

function normalizeUnitName(name) {
  return String(name || "")
    .replace(/\.service$/i, "")
    .replace(/\.socket$/i, "")
    .replace(/\.timer$/i, "")
    .trim();
}

function getBootId() {
  try {
    const p = "/proc/sys/kernel/random/boot_id";
    if (existsSync(p)) {
      return readFileSync(p, "utf8").trim();
    }
  } catch {
    /* fall through */
  }
  const r = sh("cat /proc/sys/kernel/random/boot_id");
  return r.ok ? r.out : "unknown";
}

function getBootTime() {
  // Prefer uptime -s (ISO-ish local time since boot started)
  const up = sh("uptime -s");
  if (up.ok && up.out) return up.out;

  const who = sh("who -b");
  if (who.ok && who.out) {
    // e.g. "         system boot  2026-07-09 10:15"
    const m = who.out.match(/boot\s+(.+)$/i);
    if (m) return m[1].trim();
    return who.out.replace(/\s+/g, " ").trim();
  }
  return "unknown";
}

function getUptimeSeconds() {
  try {
    const raw = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
    return Number.parseFloat(raw) || null;
  } catch {
    return null;
  }
}

/**
 * Parse `systemctl --failed --no-legend --plain` output.
 * Lines look like: UNIT LOAD ACTIVE SUB DESCRIPTION
 * or plain unit names depending on version/flags.
 */
function listFailedUnits() {
  const r = sh("systemctl --failed --no-legend --plain --no-pager");
  if (!r.ok && !r.out) {
    return { ok: false, units: [], raw: r.out || "systemctl --failed failed" };
  }
  const units = [];
  for (const line of r.out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // First field is the unit name
    const unit = t.split(/\s+/)[0];
    if (unit && unit.includes(".")) {
      units.push(unit);
    } else if (unit) {
      units.push(unit.endsWith(".service") ? unit : `${unit}.service`);
    }
  }
  return { ok: true, units, raw: r.out };
}

/**
 * Scrape journal since boot for crash/OOM/watchdog patterns.
 * Caps output to keep reports small.
 */
function scrapeJournalSignals() {
  // Prefer since boot; also useful after long uptimes. -b is current boot.
  // Limit with --no-pager and grep to avoid huge buffers.
  const pattern = JOURNAL_PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // journalctl -b --no-pager, then filter; timeout generous for busy hosts
  const cmd = `journalctl -b --no-pager -o short-iso 2>/dev/null | grep -iE '${pattern}' | tail -n 80`;
  const r = sh(cmd, { timeout: 60_000 });

  // Fallback: last 2 hours if -b returned nothing usable (or journal empty)
  let lines = r.ok && r.out ? r.out.split("\n").filter(Boolean) : [];
  let source = "journalctl -b";

  if (lines.length === 0) {
    const r2 = sh(
      `journalctl --since "2 hours ago" --no-pager -o short-iso 2>/dev/null | grep -iE '${pattern}' | tail -n 80`,
      { timeout: 60_000 }
    );
    lines = r2.ok && r2.out ? r2.out.split("\n").filter(Boolean) : [];
    source = 'journalctl --since "2 hours ago"';
  }

  const lower = lines.map((l) => l.toLowerCase());
  const hasOom = lower.some(
    (l) =>
      l.includes("out of memory") ||
      l.includes("oom-kill") ||
      l.includes("oom_reaper") ||
      l.includes("killed process") ||
      l.includes("memory cgroup out of memory")
  );
  // Strict: bare "panic" / soft "watchdog" appear in non-fatal logs and inflate severity.
  const hasPanic = lower.some(
    (l) =>
      l.includes("kernel panic") ||
      l.includes("not syncing: panic") ||
      /\bkernel panic\b/.test(l)
  );
  const hasSegfault = lower.some(
    (l) =>
      l.includes("segfault at") ||
      l.includes("segfaulted") ||
      l.includes("general protection fault") ||
      /segfault \(.*\)/.test(l)
  );
  const hasCoreDump = lower.some(
    (l) => l.includes("core dump") || l.includes("core-dump") || l.includes("dumped core")
  );
  const hasWatchdog = lower.some(
    (l) =>
      l.includes("watchdog failed") ||
      l.includes("watchdog: bug") ||
      l.includes("software watchdog") ||
      l.includes("hard lockup") ||
      l.includes("soft lockup")
  );
  const hasFailedResult = lower.some((l) => l.includes("failed with result"));

  // Hard OOM: kernel OOM killer / panic-adjacent memory death (not just user "Failed with result")
  const hasHardOom = lower.some(
    (l) =>
      l.includes("oom-kill") ||
      l.includes("out of memory: kill") ||
      l.includes("oom_reaper") ||
      l.includes("memory cgroup out of memory") ||
      (l.includes("out of memory") && l.includes("killed process"))
  );

  return {
    source,
    match_count: lines.length,
    lines: lines.slice(0, 80),
    signals: {
      oom: hasOom,
      hard_oom: hasHardOom,
      panic: hasPanic,
      segfault: hasSegfault,
      core_dump: hasCoreDump,
      watchdog: hasWatchdog,
      failed_with_result: hasFailedResult,
    },
  };
}

/**
 * df -P for / and /tmp. Returns use percent and free human fields.
 */
function checkDisk() {
  const r = sh("df -P / /tmp");
  const mounts = {};
  if (!r.ok && !r.out) {
    return { ok: false, mounts, raw: r.out };
  }
  const lines = r.out.split("\n").slice(1); // skip header
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    // Filesystem 1024-blocks Used Available Capacity Mounted
    const filesystem = parts[0];
    const blocks = Number(parts[1]);
    const used = Number(parts[2]);
    const available = Number(parts[3]);
    const capacityStr = parts[4]; // e.g. "42%"
    const mount = parts[5];
    const usePercent = Number.parseInt(capacityStr, 10);
    mounts[mount] = {
      filesystem,
      blocks_1k: blocks,
      used_1k: used,
      available_1k: available,
      use_percent: Number.isFinite(usePercent) ? usePercent : null,
      capacity: capacityStr,
    };
  }
  return { ok: true, mounts, raw: r.out };
}

/**
 * nvidia-smi summary only; never throws / never fails host if missing.
 */
function checkNvidia() {
  const which = sh("command -v nvidia-smi");
  if (!which.ok || !which.out) {
    return { present: false, summary: null, detail: "nvidia-smi not found" };
  }
  // One-line summary query
  const r = sh(
    "nvidia-smi --query-gpu=index,name,driver_version,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader",
    { timeout: 15_000 }
  );
  if (!r.ok) {
    return {
      present: true,
      summary: null,
      detail: r.out.slice(0, 300) || "nvidia-smi failed",
    };
  }
  return {
    present: true,
    summary: r.out.split("\n").slice(0, 4).join(" | ").slice(0, 500),
    detail: r.out.slice(0, 1000),
  };
}

function computeSeverity({ failedUnits, journal, disk }) {
  const failedBase = failedUnits.units.map(normalizeUnitName);
  const coreFailed = failedBase.filter((u) => CORE_SERVICES.includes(u));
  const anyFailed = failedUnits.units.length > 0;
  const diskHigh = Object.values(disk.mounts || {}).some(
    (m) => m.use_percent != null && m.use_percent > 90
  );

  const sig = journal.signals || {};
  const hasOomOrPanic = Boolean(sig.oom || sig.panic);
  const rebootRecommended = Boolean(sig.panic || sig.hard_oom);

  let severity = "ok";
  if (coreFailed.length > 0 || hasOomOrPanic) {
    severity = "critical";
  } else if (diskHigh || anyFailed) {
    severity = "warn";
  }

  return {
    severity,
    reboot_recommended: rebootRecommended,
    core_failed: coreFailed,
    any_failed: anyFailed,
    disk_high: diskHigh,
    reasons: [
      coreFailed.length ? `core failed units: ${coreFailed.join(", ")}` : null,
      hasOomOrPanic
        ? `journal: ${[sig.oom && "oom", sig.panic && "panic"].filter(Boolean).join("+")}`
        : null,
      diskHigh ? "disk use >90% on / or /tmp" : null,
      anyFailed && !coreFailed.length
        ? `non-core failed units: ${failedUnits.units.join(", ")}`
        : null,
    ].filter(Boolean),
  };
}

/**
 * Run full crash analysis. Never throws to caller in normal paths;
 * always returns a report object. Does not restart services.
 */
export function runCrashAnalysis() {
  const started = new Date().toISOString();
  let report;

  try {
    const boot_id = getBootId();
    const boot_time = getBootTime();
    const uptime_seconds = getUptimeSeconds();
    const failed = listFailedUnits();
    const journal = scrapeJournalSignals();
    const disk = checkDisk();
    const nvidia = checkNvidia();
    const sev = computeSeverity({
      failedUnits: failed,
      journal,
      disk,
    });

    report = {
      story: "diamondnode crash / post-reboot analysis (read-only)",
      started,
      finished: new Date().toISOString(),
      boot: {
        boot_id,
        boot_time,
        uptime_seconds,
      },
      failed_units: {
        count: failed.units.length,
        units: failed.units,
        core_failed: sev.core_failed,
        raw: failed.raw?.slice(0, 2000) || "",
      },
      journal: {
        source: journal.source,
        match_count: journal.match_count,
        signals: journal.signals,
        lines: journal.lines,
      },
      disk: disk.mounts,
      nvidia,
      severity: sev.severity,
      reboot_recommended: sev.reboot_recommended,
      reasons: sev.reasons,
      allowlist: CORE_SERVICES,
    };
  } catch (e) {
    report = {
      story: "diamondnode crash / post-reboot analysis (read-only)",
      started,
      finished: new Date().toISOString(),
      severity: "warn",
      reboot_recommended: false,
      error: String(e?.message || e),
      reasons: ["analysis exception (partial report)"],
      boot: { boot_id: "unknown", boot_time: "unknown", uptime_seconds: null },
      failed_units: { count: 0, units: [], core_failed: [], raw: "" },
      journal: {
        source: "none",
        match_count: 0,
        signals: {},
        lines: [],
      },
      disk: {},
      nvidia: { present: false, summary: null, detail: "skipped" },
      allowlist: CORE_SERVICES,
    };
  }

  const outDir = join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });
  const isoSafe = started.replace(/[:.]/g, "-");
  const stamped = join(outDir, `crash-analysis-${isoSafe}.json`);
  const latest = join(outDir, "crash-analysis-latest.json");
  const body = JSON.stringify(report, null, 2);
  writeFileSync(stamped, body);
  writeFileSync(latest, body);

  return { report, path: stamped, latest };
}

function formatSummary(report) {
  const lines = [
    `## Crash Analysis: diamondnode`,
    ``,
    `**When**: ${report.started}`,
    `**Severity**: ${report.severity}`,
    `**Reboot recommended**: ${report.reboot_recommended}`,
    `**Boot id**: ${report.boot?.boot_id || "n/a"}`,
    `**Boot time**: ${report.boot?.boot_time || "n/a"}`,
    ``,
    `### Failed units (${report.failed_units?.count ?? 0})`,
    ...(report.failed_units?.units?.length
      ? report.failed_units.units.map((u) => `- ${u}`)
      : ["- none"]),
    ``,
    `### Journal signals`,
    `\`${JSON.stringify(report.journal?.signals || {})}\` (${report.journal?.match_count ?? 0} lines)`,
    ``,
    `### Disk`,
    ...Object.entries(report.disk || {}).map(
      ([m, d]) => `- ${m}: ${d.capacity ?? d.use_percent + "%"} used`
    ),
    ``,
    `### GPU`,
    report.nvidia?.present
      ? `- ${report.nvidia.summary || report.nvidia.detail}`
      : `- ${report.nvidia?.detail || "not present"}`,
    ``,
    `### Reasons`,
    ...(report.reasons?.length ? report.reasons.map((r) => `- ${r}`) : ["- none"]),
  ];
  return lines.join("\n");
}

function isMain() {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? join(process.argv[1]) : "";
    // Compare resolved paths loosely (symlink / relative argv)
    return (
      thisFile === argv1 ||
      process.argv[1]?.endsWith("crash-analyze.mjs") ||
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    return process.argv[1]?.endsWith("crash-analyze.mjs");
  }
}

if (isMain()) {
  try {
    const { report, path } = runCrashAnalysis();
    console.log(formatSummary(report));
    console.log(`\nWrote ${path}`);
    console.log(`Wrote reports/crash-analysis-latest.json`);
  } catch (e) {
    // Absolute last resort: still exit 0
    console.error("crash-analyze unexpected error:", e?.message || e);
  }
  process.exit(0);
}

export { formatSummary, CORE_SERVICES };
