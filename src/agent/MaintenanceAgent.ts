/**
 * Cloudflare Agents SDK — Ops Maintenance Agent
 * Schedules verification cycles, PR inventory, and Kimi status pushes.
 *
 * Deploy: npm run agent:deploy (requires wrangler auth + CF account)
 */
import { Agent } from "agents";

export type OpsState = {
  lastCycleAt: string | null;
  lastSummary: string | null;
  cycleCount: number;
  lastError: string | null;
};

export class MaintenanceAgent extends Agent<Env, OpsState> {
  initialState: OpsState = {
    lastCycleAt: null,
    lastSummary: null,
    cycleCount: 0,
    lastError: null,
  };

  async onStart() {
    // Every 15 minutes — durable schedule survives DO hibernation
    await this.schedule("*/15 * * * *", "runMaintenanceCycle", {});
  }

  async runMaintenanceCycle(_payload: Record<string, never>) {
    const started = new Date().toISOString();
    try {
      // In Worker context we call the diamondnode control plane webhook
      const base = this.env.DIAMONDNODE_OPS_URL || "http://127.0.0.1:8787";
      const res = await fetch(`${base}/ops/maintenance-cycle`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.OPS_TOKEN || ""}`,
        },
        body: JSON.stringify({ source: "MaintenanceAgent", at: started }),
      });
      const text = await res.text();
      this.setState({
        lastCycleAt: started,
        lastSummary: text.slice(0, 2000),
        cycleCount: (this.state.cycleCount || 0) + 1,
        lastError: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 500)}`,
      });
    } catch (e) {
      this.setState({
        ...this.state,
        lastCycleAt: started,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({ state: this.state, agent: "MaintenanceAgent" });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      await this.runMaintenanceCycle({});
      return Response.json({ ok: true, state: this.state });
    }
    return new Response("ops-maintenance-agent", { status: 200 });
  }
}

export type Env = {
  MaintenanceAgent: DurableObjectNamespace;
  DIAMONDNODE_OPS_URL?: string;
  OPS_TOKEN?: string;
};
