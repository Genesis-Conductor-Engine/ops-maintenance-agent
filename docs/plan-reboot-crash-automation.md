# Plan: Post-Reboot & Crash Auto-Reconfig + Analysis

## Goal
Complete automation on diamondnode so that after reboot or process/service crash:
1. Detect boot vs crash context
2. Collect analysis (journal, failed units, OOM, disk, GPU)
3. Auto-reconfigure and restart safe core services
4. Re-run verification + Kimi notify
5. Persist reports for the 15m maintenance cycle

## Non-goals
- Never disable or restart ssh as a "fix"
- Never force-push or mutate git remotes
- No gh/axiom/sentry credential fabrication

## Architecture
```
systemd multi-user.target
  └─ ops-post-boot.service (oneshot, After=network-online)
       └─ scripts/post-boot-reconfig.mjs
            ├─ detect boot id / previous crash
            ├─ analyze (journal, failed units, dmesg OOM)
            ├─ heal (restart allowlisted services)
            ├─ reconfig (enable+start core units, openclaw, ops-http)
            └─ notify (kimi + reports/boot-*.json)

systemd path/failure hooks
  └─ ops-crash-watch@.service  (optional template)
  └─ scripts/crash-analyze.mjs  (also callable from maintenance-cycle)
```

## Restart allowlist (safe)
openclaw-gateway, ollama, nginx, diamond-gateway, redis-server,
qmem-llama-server, qmem-sync, genesis-ops-stream, cloudflared,
ops-maintenance-http

## Never touch for heal restarts
ssh, sshd, systemd-*, dbus, networkd, docker (unless later explicit)

## Tasks

### Task 1: Crash analysis module
Create `scripts/crash-analyze.mjs` that:
- Detects last boot id (`/proc/sys/kernel/random/boot_id`)
- Lists failed systemd units (`systemctl --failed`)
- Scrapes recent journal for OOM, segfault, panic, core dump lines (last 2h or since boot)
- Checks disk free on / and /tmp
- Checks nvidia-smi if present
- Writes `reports/crash-analysis-latest.json` and timestamped copy
- Exports `runCrashAnalysis()` and CLI main
- Exit 0 always (analysis never fails the host); include `severity` boolean

### Task 2: Post-boot reconfig + heal
Create `scripts/post-boot-reconfig.mjs` that:
- Calls crash analysis
- Ensures allowlisted services are enabled and active; restart if inactive/failed
- Ensures ops-maintenance-http is running
- Ensures openclaw-gateway is running (Kimi path)
- Waits up to 30s for gateway stabilize
- Runs verification (import runVerification)
- Sends Kimi update with boot/crash summary via sendKimiUpdate
- Writes `reports/post-boot-latest.json`
- CLI: `node scripts/post-boot-reconfig.mjs [--force-heal]`

### Task 3: systemd units for boot + crash
Create and install:
- `systemd/ops-post-boot.service` — oneshot, WantedBy=multi-user.target, After=network-online.target, TimeoutStartSec=180
- Optional: `systemd/ops-crash-analyze.service` + timer every 30m as backup analysis (or rely on maintenance cycle)
- Wire `maintenance-cycle.mjs` to call crash analysis when any core service was down or verification critical fails
- install helper: `scripts/install-automation.sh`

### Task 4: Integrate + verify end-to-end
- Update README/STATUS
- Install units, enable ops-post-boot
- Dry-run post-boot and crash-analyze
- Confirm reports written and no ssh restart

## Acceptance
- [ ] After simulated inactive openclaw-gateway, post-boot heals it back to active
- [ ] crash-analyze produces JSON with failed units + journal signals
- [ ] ops-post-boot.service enabled
- [ ] Kimi notified on post-boot run (if token present)
- [ ] ssh never in restart list
