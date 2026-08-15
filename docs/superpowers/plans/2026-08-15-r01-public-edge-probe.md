# R01 Public-Edge Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `r01_readiness.public_edge_ok` a live HTTP probe of `/health` (HTTP 200 only) so a Cloudflare 1050 cannot be reported as a healthy public edge.

**Architecture:** A new pure module `scripts/r01-public-edge.mjs` decides readiness from injected probe fields (URL, mode, status, optional body snippet, optional tunnel counters). `scripts/verify.mjs` records the public `/health` HTTP status. `writeR01GoLive` in `scripts/maintenance-cycle.mjs` calls the module and appends blockers. Unit tests use `node:test` and never curl production or write `reports/`.

**Tech Stack:** Node.js ESM, `node:test` / `node:assert/strict`, existing ops scripts. No new dependencies.

## Global Constraints

- Work only under `/root/ops-maintenance-agent/.worktrees/r01-public-edge-probe` on branch `feat/r01-public-edge-probe`.
- Tests: `node --test scripts/r01-public-edge.test.mjs` from the worktree cwd. Do not add a root `npm test` script.
- `public_edge_ok` is true only when `publicUrl` is non-empty and `healthStatus === 200`. Mode `named-or-custom` or `is_trycloudflare` must not override a failed probe.
- Cloudflare 1050: `healthStatus === 403` and body snippet matching `/error code:\s*1050/i` → reason `"cf_1050"`.
- Never write `/root/.vault`, never set `ALLOW_LIVE_WRITE`, never `systemctl restart` / enable / start any unit, never run `npm run cycle` or `node scripts/maintenance-cycle.mjs` or `node scripts/goal-scorecard.mjs` (those rewrite live reports).
- Never print, commit, or log secrets, tunnel credentials, or webhook values.
- Do not treat `estimated_mrr` or scorecard `total_mrr_usd` as `mrr_actual`.
- Follow TDD: failing test first, then minimal implementation. Commit after each task is green.
- Do not restructure unrelated `maintenance-cycle.mjs` logic. Do not restart cloudflared.

## File structure

| File | Responsibility |
|------|----------------|
| `scripts/r01-public-edge.mjs` | Pure evaluators + readiness/blocker builders |
| `scripts/r01-public-edge.test.mjs` | Behavior tests (no network, no report writes) |
| `scripts/verify.mjs` | Public probe includes numeric `status` |
| `scripts/maintenance-cycle.mjs` | `writeR01GoLive` consumes the module |

---

### Task 1: Pure public-edge and tunnel evaluators

**Files:**
- Create: `scripts/r01-public-edge.mjs`
- Create: `scripts/r01-public-edge.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `evaluatePublicEdge({ publicUrl, mode, healthStatus, healthBody })` → `{ ok: boolean, reason: string, healthStatus: number | null }`
    - `reason` one of: `"no_url"`, `"http_200"`, `"cf_1050"`, `"http_not_200"`
    - `mode` is informational only; it must not flip `ok` to true
  - `evaluateTunnelControlPlane({ unitActive, registeredConnections })` → `{ live: boolean | null, reason: string }`
    - `registeredConnections` missing/`null`/`undefined` → `{ live: null, reason: "unknown" }`
    - `unitActive === false` → `{ live: false, reason: "unit_inactive" }`
    - `unitActive === true` and `registeredConnections === 0` → `{ live: false, reason: "systemd_only" }`
    - `unitActive === true` and `registeredConnections > 0` → `{ live: true, reason: "registered" }`
  - `countRegisteredTunnelConnections(journalText)` → integer count of lines containing `Registered tunnel connection`
  - `buildR01Readiness({ publicUrl, mode, healthStatus, healthBody, tunnelUnitActive, registeredConnections })` →
    ```js
    {
      public_edge_ok: boolean,
      public_edge_reason: string,
      public_health_status: number | null,
      tunnel_unit_active: boolean,
      tunnel_control_plane_ok: boolean | null,
      tunnel_control_plane_reason: string,
    }
    ```
  - `buildPublicEdgeBlockers(readiness)` → `string[]` using these exact strings when applicable:
    - no url: `"public URL not written"`
    - `cf_1050`: `"public /health blocked (Cloudflare 1050); origin may be healthy"`
    - other failed probe: `"public /health is not HTTP 200"`
    - `systemd_only`: `"cloudflared-inference is active but has no registered Cloudflare control connection"`
    - no blocker when `tunnel_control_plane_reason === "unknown"`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePublicEdge,
  evaluateTunnelControlPlane,
  countRegisteredTunnelConnections,
  buildR01Readiness,
  buildPublicEdgeBlockers,
} from "./r01-public-edge.mjs";

test("named-or-custom mode does not make a 403 edge look healthy", () => {
  const r = evaluatePublicEdge({
    publicUrl: "https://inference.yennefer.quest",
    mode: "named-or-custom",
    healthStatus: 403,
    healthBody: "error code: 1050",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cf_1050");
  assert.equal(r.healthStatus, 403);
});

test("public_edge_ok is true only on HTTP 200", () => {
  const r = evaluatePublicEdge({
    publicUrl: "https://inference.yennefer.quest",
    mode: "named-or-custom",
    healthStatus: 200,
    healthBody: '{"ok":true}',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "http_200");
});

test("trycloudflare does not override a failed probe", () => {
  const r = evaluatePublicEdge({
    publicUrl: "https://example.trycloudflare.com",
    mode: "quick-tunnel",
    healthStatus: 502,
    healthBody: "",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "http_not_200");
});

test("missing URL is not a healthy edge", () => {
  const r = evaluatePublicEdge({
    publicUrl: "",
    mode: "unset",
    healthStatus: null,
    healthBody: "",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_url");
});

test("systemd-active tunnel with zero registrations is not live", () => {
  const t = evaluateTunnelControlPlane({
    unitActive: true,
    registeredConnections: 0,
  });
  assert.equal(t.live, false);
  assert.equal(t.reason, "systemd_only");
});

test("unknown registration count does not claim the control plane is live", () => {
  const t = evaluateTunnelControlPlane({ unitActive: true });
  assert.equal(t.live, null);
  assert.equal(t.reason, "unknown");
});

test("counts Registered tunnel connection lines", () => {
  const n = countRegisteredTunnelConnections(
    "INF Registered tunnel connection connIndex=0\nWRN control stream encountered a failure\nINF Registered tunnel connection connIndex=1\n"
  );
  assert.equal(n, 2);
});

test("buildR01Readiness + blockers for the live 1050 failure", () => {
  const readiness = buildR01Readiness({
    publicUrl: "https://inference.yennefer.quest",
    mode: "named-or-custom",
    healthStatus: 403,
    healthBody: "error code: 1050",
    tunnelUnitActive: true,
    registeredConnections: 0,
  });
  assert.equal(readiness.public_edge_ok, false);
  assert.equal(readiness.public_edge_reason, "cf_1050");
  assert.equal(readiness.tunnel_control_plane_ok, false);
  const blockers = buildPublicEdgeBlockers(readiness);
  assert.ok(
    blockers.includes(
      "public /health blocked (Cloudflare 1050); origin may be healthy"
    )
  );
  assert.ok(
    blockers.includes(
      "cloudflared-inference is active but has no registered Cloudflare control connection"
    )
  );
});

test("unknown tunnel registrations do not add a control-plane blocker", () => {
  const readiness = buildR01Readiness({
    publicUrl: "https://inference.yennefer.quest",
    mode: "named-or-custom",
    healthStatus: 200,
    healthBody: "",
    tunnelUnitActive: true,
  });
  assert.equal(readiness.public_edge_ok, true);
  assert.equal(readiness.tunnel_control_plane_ok, null);
  assert.deepEqual(buildPublicEdgeBlockers(readiness), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/r01-public-edge.test.mjs`

Expected: FAIL because `scripts/r01-public-edge.mjs` does not exist (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Write the minimal module**

```js
const CF_1050 = /error code:\s*1050/i;
const REGISTERED = /Registered tunnel connection/;

export function evaluatePublicEdge({
  publicUrl,
  mode,
  healthStatus,
  healthBody,
} = {}) {
  void mode;
  const url = typeof publicUrl === "string" ? publicUrl.trim() : "";
  const status =
    typeof healthStatus === "number" && Number.isFinite(healthStatus)
      ? healthStatus
      : null;
  if (!url) {
    return { ok: false, reason: "no_url", healthStatus: status };
  }
  if (status === 200) {
    return { ok: true, reason: "http_200", healthStatus: status };
  }
  const body = typeof healthBody === "string" ? healthBody : "";
  if (status === 403 && CF_1050.test(body)) {
    return { ok: false, reason: "cf_1050", healthStatus: status };
  }
  return { ok: false, reason: "http_not_200", healthStatus: status };
}

export function evaluateTunnelControlPlane({
  unitActive,
  registeredConnections,
} = {}) {
  if (
    registeredConnections === undefined ||
    registeredConnections === null
  ) {
    return { live: null, reason: "unknown" };
  }
  if (!unitActive) {
    return { live: false, reason: "unit_inactive" };
  }
  if (registeredConnections > 0) {
    return { live: true, reason: "registered" };
  }
  return { live: false, reason: "systemd_only" };
}

export function countRegisteredTunnelConnections(journalText) {
  const text = typeof journalText === "string" ? journalText : "";
  return text.split(/\r?\n/).filter((line) => REGISTERED.test(line)).length;
}

export function buildR01Readiness(input = {}) {
  const edge = evaluatePublicEdge(input);
  const tunnel = evaluateTunnelControlPlane({
    unitActive: Boolean(input.tunnelUnitActive),
    registeredConnections: input.registeredConnections,
  });
  return {
    public_edge_ok: edge.ok,
    public_edge_reason: edge.reason,
    public_health_status: edge.healthStatus,
    tunnel_unit_active: Boolean(input.tunnelUnitActive),
    tunnel_control_plane_ok: tunnel.live,
    tunnel_control_plane_reason: tunnel.reason,
  };
}

export function buildPublicEdgeBlockers(readiness = {}) {
  const blockers = [];
  if (readiness.public_edge_reason === "no_url") {
    blockers.push("public URL not written");
  } else if (readiness.public_edge_reason === "cf_1050") {
    blockers.push(
      "public /health blocked (Cloudflare 1050); origin may be healthy"
    );
  } else if (readiness.public_edge_ok === false) {
    blockers.push("public /health is not HTTP 200");
  }
  if (readiness.tunnel_control_plane_reason === "systemd_only") {
    blockers.push(
      "cloudflared-inference is active but has no registered Cloudflare control connection"
    );
  }
  return blockers;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/r01-public-edge.test.mjs`

Expected: PASS, all tests, output pristine.

- [ ] **Step 5: Commit**

```bash
git add scripts/r01-public-edge.mjs scripts/r01-public-edge.test.mjs
git commit -m "$(cat <<'EOF'
feat(r01): treat public_edge_ok as a live /health probe

Named-tunnel mode must not mark Cloudflare 1050 as a healthy edge.
EOF
)"
```

---

### Task 2: Wire verify probe status and writeR01GoLive

**Files:**
- Modify: `scripts/verify.mjs` (`checkInferenceMeter` public probe object)
- Modify: `scripts/maintenance-cycle.mjs` (`writeR01GoLive` readiness + `go_live_blockers`)
- Test: `scripts/r01-public-edge.test.mjs` (add parse helper tests if you add `parseHealthStatusFromProbe`)

**Interfaces:**
- Consumes: `buildR01Readiness`, `buildPublicEdgeBlockers` from Task 1
- Produces:
  - `checkInferenceMeter().public.probe.status` — `number | null` (parsed HTTP code from curl `-w '%{http_code}'`, or `null` if skipped/unparseable)
  - `checkInferenceMeter().public.probe.body` — first 200 chars of the health response body (empty string if skipped). Capture with a second curl or `-w` plus body; do not log it beyond the probe object.
  - `writeR01GoLive` `readiness.public_edge_ok` comes from `buildR01Readiness`, not from `public_url_mode === "named-or-custom"`
  - `writeR01GoLive` `readiness` includes `public_edge_reason`, `public_health_status`, `tunnel_control_plane_ok`, `tunnel_control_plane_reason`
  - `go_live_blockers` concatenates existing non-edge blockers (meter health, stripe webhook, checkout links) with `buildPublicEdgeBlockers(readiness)` and de-duplicates
  - Do **not** invoke `journalctl` or restart units. Pass `registeredConnections` only if already present on `meter` (otherwise omit so reason is `"unknown"`)

- [ ] **Step 1: Write a failing test for probe-status parsing**

Append to `scripts/r01-public-edge.test.mjs`:

```js
import { parseHealthStatus } from "./r01-public-edge.mjs";

test("parseHealthStatus reads a trailing HTTP code", () => {
  assert.equal(parseHealthStatus("403"), 403);
  assert.equal(parseHealthStatus("200"), 200);
  assert.equal(parseHealthStatus(""), null);
  assert.equal(parseHealthStatus("fail"), null);
});
```

If `parseHealthStatus` is not exported yet, this fails with a named export error (expected RED).

- [ ] **Step 2: Run the new test to verify RED**

Run: `node --test scripts/r01-public-edge.test.mjs`

Expected: FAIL on missing `parseHealthStatus`.

- [ ] **Step 3: Add parseHealthStatus and wire callers**

In `scripts/r01-public-edge.mjs` add:

```js
export function parseHealthStatus(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{3}$/.test(s)) return null;
  return Number(s);
}
```

In `scripts/verify.mjs` inside `checkInferenceMeter`, when `pub.public_url` is set, keep the existing curl for the status code and add a body fetch (timeout 5s). Shape:

```js
const status = parseHealthStatus(code.out);
const httpOk = status === 200;
publicProbe = {
  ok: httpOk,
  skipped: false,
  status,
  body: bodyText.slice(0, 200),
  detail: httpOk
    ? `${pub.public_url}/health → 200${pub.is_trycloudflare ? " (trycloudflare)" : ""}`
    : `${pub.public_url}/health → ${status ?? code.out || "fail"}${pub.is_trycloudflare ? " (trycloudflare optional)" : ""}`,
};
```

Import `parseHealthStatus` from `./r01-public-edge.mjs`. Do not change verify's critical/optional scoring: public URL presence remains non-critical.

In `scripts/maintenance-cycle.mjs` import `buildR01Readiness` and `buildPublicEdgeBlockers`. Replace the `public_edge_ok` expression with:

```js
const probe = meter?.public?.probe || {};
const edgeReadiness = buildR01Readiness({
  publicUrl: inference.public_url,
  mode: inference.public_url_mode,
  healthStatus: probe.status ?? (probe.ok === true ? 200 : null),
  healthBody: probe.body || probe.detail || "",
  tunnelUnitActive:
    meter?.tunnel_unit === "active" || isUnitActive("cloudflared-inference"),
  registeredConnections: meter?.tunnel_registered_connections,
});
```

Merge `edgeReadiness` fields into `readiness` (keep existing meter/unit/url fields). Build `go_live_blockers` as:

```js
go_live_blockers: [
  !inference.meter_health_ok && "inference meter health down",
  !inference.stripe_webhook_secret &&
    "STRIPE_WEBHOOK_SECRET missing in vault (webhook returns 503 until set)",
  !Object.values(inference.stripe_checkout_urls || {}).some(Boolean) &&
    "Stripe checkout Payment Links not set (optional until Dashboard products exist)",
  ...buildPublicEdgeBlockers(edgeReadiness),
].filter(Boolean),
```

Do not keep a separate `"public URL not written"` line that would duplicate `buildPublicEdgeBlockers`.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/r01-public-edge.test.mjs`

Expected: PASS.

Optional syntax check (do not run the cycle): `node --check scripts/verify.mjs && node --check scripts/maintenance-cycle.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/r01-public-edge.mjs scripts/r01-public-edge.test.mjs scripts/verify.mjs scripts/maintenance-cycle.mjs
git commit -m "$(cat <<'EOF'
fix(r01): record public /health status and stop lying about the edge

writeR01GoLive now requires HTTP 200. Cloudflare 1050 becomes a go-live blocker.
EOF
)"
```
