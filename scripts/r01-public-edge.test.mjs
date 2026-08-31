import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePublicEdge,
  evaluateTunnelControlPlane,
  countRegisteredTunnelConnections,
  buildR01Readiness,
  buildPublicEdgeBlockers,
  parseHealthStatus,
} from "./r01-public-edge.mjs";

test("parseHealthStatus reads a trailing HTTP code", () => {
  assert.equal(parseHealthStatus("403"), 403);
  assert.equal(parseHealthStatus("200"), 200);
  assert.equal(parseHealthStatus(""), null);
  assert.equal(parseHealthStatus("fail"), null);
});

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
