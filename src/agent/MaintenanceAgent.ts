/**
 * Cloudflare Agents SDK — Ops Maintenance Agent
 * Schedules verification cycles, procedural truth, goal scorecard, Kimi pushes.
 *
 * Deploy: npm run agent:deploy (requires wrangler auth + CF account)
 */
import { Agent, callable } from "agents";

export type OpsState = {
  lastCycleAt: string | null;
  lastSummary: string | null;
  cycleCount: number;
  lastError: string | null;
  lastCrystal: number | null;
  lastPtvOk: boolean | null;
  lastGoalMrr: number | null;
  lastStreamsAtFloor: number | null;
};

export class MaintenanceAgent extends Agent<Env, OpsState> {
  initialState: OpsState = {
    lastCycleAt: null,
    lastSummary: null,
    cycleCount: 0,
    lastError: null,
    lastCrystal: null,
    lastPtvOk: null,
    lastGoalMrr: null,
    lastStreamsAtFloor: null,
  };

  async onStart() {
    // Every 15 minutes — durable schedule survives DO hibernation
    await this.schedule("*/15 * * * *", "runMaintenanceCycle", {});
    // Goal scorecard hourly (north star 13×$70k)
    await this.schedule("0 * * * *", "runGoalScorecard", {});
  }

  private opsBase(): string {
    return this.env.DIAMONDNODE_OPS_URL || "http://127.0.0.1:8791";
  }

  private authHeaders(): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.env.OPS_TOKEN || ""}`,
    };
  }

  async runMaintenanceCycle(_payload: Record<string, never>) {
    const started = new Date().toISOString();
    try {
      const base = this.opsBase();
      const res = await fetch(`${base}/ops/maintenance-cycle`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ source: "MaintenanceAgent", at: started }),
      });
      const text = await res.text();

      // Procedural truth + scorecard (best-effort; non-fatal)
      let crystal: number | null = this.state.lastCrystal;
      let ptvOk: boolean | null = this.state.lastPtvOk;
      let goalMrr: number | null = this.state.lastGoalMrr;
      let streamsAtFloor: number | null = this.state.lastStreamsAtFloor;
      try {
        const ptv = await fetch(`${base}/ops/procedural-truth`, {
          method: "POST",
          headers: this.authHeaders(),
        });
        if (ptv.ok) {
          const j = (await ptv.json()) as {
            ok?: boolean;
            crystal_value?: number;
          };
          ptvOk = Boolean(j.ok);
          crystal = typeof j.crystal_value === "number" ? j.crystal_value : null;
        }
      } catch {
        /* ignore */
      }
      try {
        const gs = await fetch(`${base}/ops/goal-scorecard`, {
          method: "POST",
          headers: this.authHeaders(),
        });
        if (gs.ok) {
          const j = (await gs.json()) as {
            totals?: { total_mrr_usd?: number; streams_at_floor?: number };
          };
          goalMrr = j.totals?.total_mrr_usd ?? null;
          streamsAtFloor = j.totals?.streams_at_floor ?? null;
        }
      } catch {
        /* ignore */
      }

      this.setState({
        lastCycleAt: started,
        lastSummary: text.slice(0, 2000),
        cycleCount: (this.state.cycleCount || 0) + 1,
        lastError: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 500)}`,
        lastCrystal: crystal,
        lastPtvOk: ptvOk,
        lastGoalMrr: goalMrr,
        lastStreamsAtFloor: streamsAtFloor,
      });
    } catch (e) {
      this.setState({
        ...this.state,
        lastCycleAt: started,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async runGoalScorecard(_payload: Record<string, never>) {
    const base = this.opsBase();
    try {
      const gs = await fetch(`${base}/ops/goal-scorecard`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      if (!gs.ok) {
        this.setState({
          ...this.state,
          lastError: `goal-scorecard HTTP ${gs.status}`,
        });
        return;
      }
      const j = (await gs.json()) as {
        totals?: { total_mrr_usd?: number; streams_at_floor?: number };
        procedural_truth?: { ok?: boolean; crystal_value?: number };
      };
      this.setState({
        ...this.state,
        lastGoalMrr: j.totals?.total_mrr_usd ?? null,
        lastStreamsAtFloor: j.totals?.streams_at_floor ?? null,
        lastPtvOk: j.procedural_truth?.ok ?? this.state.lastPtvOk,
        lastCrystal: j.procedural_truth?.crystal_value ?? this.state.lastCrystal,
        lastError: null,
      });
    } catch (e) {
      this.setState({
        ...this.state,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  @callable()
  async getNorthStar(): Promise<{
    streamsAtFloor: number | null;
    totalMrr: number | null;
    crystal: number | null;
    ptvOk: boolean | null;
    cycleCount: number;
  }> {
    return {
      streamsAtFloor: this.state.lastStreamsAtFloor,
      totalMrr: this.state.lastGoalMrr,
      crystal: this.state.lastCrystal,
      ptvOk: this.state.lastPtvOk,
      cycleCount: this.state.cycleCount,
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        state: this.state,
        agent: "MaintenanceAgent",
        north_star: {
          target_streams: 13,
          mrr_floor_usd: 70_000,
          combined_floor_usd: 910_000,
        },
      });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      await this.runMaintenanceCycle({});
      return Response.json({ ok: true, state: this.state });
    }
    if (url.pathname === "/goal" && request.method === "POST") {
      await this.runGoalScorecard({});
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
