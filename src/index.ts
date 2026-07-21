import { routeAgentRequest } from "agents";
import { MaintenanceAgent } from "./agent/MaintenanceAgent";

export { MaintenanceAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};

type Env = {
  MaintenanceAgent: DurableObjectNamespace;
  DIAMONDNODE_OPS_URL?: string;
  OPS_TOKEN?: string;
};
