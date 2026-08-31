const CF_1050 = /error code:\s*1050/i;
const REGISTERED = /Registered tunnel connection/;

export function parseHealthStatus(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{3}$/.test(s)) return null;
  return Number(s);
}

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
