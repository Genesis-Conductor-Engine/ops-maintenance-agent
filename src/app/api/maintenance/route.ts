/**
 * Vercel Workflow entry — POST starts a durable maintenance run.
 * Requires `withWorkflow` in next.config and `workflow` package installed.
 *
 * Deploy: link project, set DIAMONDNODE_OPS_URL + OPS_TOKEN env, vercel deploy.
 */
import { start } from "workflow/api";
import { maintenanceWorkflow } from "../../workflows/maintenanceWorkflow";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    loops?: number;
    interval?: string;
  };

  const run = await start(maintenanceWorkflow, [
    {
      baseUrl: process.env.DIAMONDNODE_OPS_URL || "http://127.0.0.1:8791",
      token: process.env.OPS_TOKEN || "",
      loops: body.loops ?? 1,
      interval: body.interval || "15m",
    },
  ]);

  return Response.json({ runId: run.runId });
}

export async function GET() {
  return Response.json({
    service: "ops-maintenance-workflow",
    endpoints: { start: "POST /api/maintenance" },
  });
}
