import { handleBridgeRequest, type BridgeEnv } from "./routes.js";

export { Sandbox } from "./sandbox.js";

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    try {
      return await handleBridgeRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "bridge.request.failed", path: new URL(request.url).pathname, error: message }));
      return new Response(JSON.stringify({ error: "internal_error", message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
