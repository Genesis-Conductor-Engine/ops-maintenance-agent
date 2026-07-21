/**
 * Vercel Workflow DevKit — durable scheduled maintenance pipeline.
 * Trigger via cron API route or `start(maintenanceWorkflow)`.
 *
 * Steps have full Node access; workflow function only orchestrates.
 */
import { sleep } from "workflow";

export type CycleResult = {
  verifyOk: boolean;
  prWatched: number;
  kimiOk: boolean;
  proceduralTruthOk: boolean;
  crystalValue?: number;
  proceduralTruthEvt?: string;
  blocked: string[];
  at: string;
};

async function runVerifyStep(baseUrl: string, token: string): Promise<{
  ok: boolean;
  blocked: string[];
  healthy: number;
  total: number;
}> {
  "use step";
  console.log("[step] verify", baseUrl);
  const res = await fetch(`${baseUrl}/ops/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { ok: false, blocked: [`verify_http_${res.status}`], healthy: 0, total: 0 };
  }
  const data = (await res.json()) as {
    summary?: { ok?: boolean; blocked?: string[]; healthyServices?: number; totalServices?: number };
  };
  return {
    ok: Boolean(data.summary?.ok),
    blocked: data.summary?.blocked || [],
    healthy: data.summary?.healthyServices || 0,
    total: data.summary?.totalServices || 0,
  };
}

async function runPrBabysitStep(baseUrl: string, token: string): Promise<{
  watched: number;
  ok: boolean;
  message: string;
}> {
  "use step";
  console.log("[step] pr-babysit");
  const res = await fetch(`${baseUrl}/ops/pr-babysit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    watched?: number;
    ok?: boolean;
    message?: string;
  };
  return {
    watched: data.watched || 0,
    ok: Boolean(data.ok),
    message: data.message || `HTTP ${res.status}`,
  };
}

async function runProceduralTruthStep(baseUrl: string, token: string): Promise<{
  ok: boolean;
  crystal_value?: number;
  evt_id?: string;
}> {
  "use step";
  console.log("[step] procedural-truth");
  const res = await fetch(`${baseUrl}/ops/procedural-truth`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    crystal_value?: number;
    evt_id?: string;
  };
  return {
    ok: Boolean(data.ok),
    crystal_value: data.crystal_value,
    evt_id: data.evt_id,
  };
}

async function runKimiUpdateStep(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean }> {
  "use step";
  console.log("[step] kimi-update");
  const res = await fetch(`${baseUrl}/ops/kimi-update`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok };
}

/**
 * Durable maintenance workflow — safe to resume after crash.
 */
export async function maintenanceWorkflow(opts?: {
  baseUrl?: string;
  token?: string;
  interval?: string;
  loops?: number;
}): Promise<CycleResult[]> {
  "use workflow";

  const baseUrl = opts?.baseUrl || "https://dn.genesisconductor.io";
  const token = opts?.token || "";
  const interval = opts?.interval || "15m";
  const loops = opts?.loops ?? 1;
  const results: CycleResult[] = [];

  for (let i = 0; i < loops; i++) {
    const verify = await runVerifyStep(baseUrl, token);
    const pr = await runPrBabysitStep(baseUrl, token);
    const ptv = await runProceduralTruthStep(baseUrl, token);
    const kimi = await runKimiUpdateStep(baseUrl, token, {
      verify,
      pr,
      procedural_truth: ptv,
      cycle: i + 1,
    });

    results.push({
      verifyOk: verify.ok,
      prWatched: pr.watched,
      kimiOk: kimi.ok,
      proceduralTruthOk: ptv.ok,
      crystalValue: ptv.crystal_value,
      proceduralTruthEvt: ptv.evt_id,
      blocked: verify.blocked,
      at: new Date().toISOString(),
    });

    if (i < loops - 1) {
      await sleep(interval);
    }
  }

  return results;
}
