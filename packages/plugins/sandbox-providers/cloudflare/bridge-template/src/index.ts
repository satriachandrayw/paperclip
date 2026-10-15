import { Sandbox as SdkSandbox } from "@cloudflare/sandbox";
import { handleBridgeRequest, } from "./routes.js";
import type { BridgeEnv } from "./sandboxes.js";
import { buildLifecycleRecord, classifyExit, lifecycleLogLevel, type LifecycleEvent, type StopInfo } from "./lifecycle.js";

/**
 * Same Durable Object class as the SDK's, plus one structured log line per
 * container start/stop/error so mid-run restarts carry an exit code and reason.
 * The exported name stays `Sandbox` so the DO binding and container app are unchanged.
 */
export class Sandbox<Env = unknown> extends SdkSandbox<Env> {
  private lifecycleStartedAt: number | null = null;

  private logLifecycle(event: LifecycleEvent, extra: { stop?: StopInfo | null; error?: unknown } = {}): void {
    try {
      const record = buildLifecycleRecord({
        event,
        durableObjectId: this.ctx.id.toString(),
        sandboxName: (this as unknown as { sandboxName?: string | null }).sandboxName ?? null,
        stop: extra.stop ?? null,
        startedAt: this.lifecycleStartedAt,
        error: extra.error,
      });
      const line = JSON.stringify({ ...record, exitClass: classifyExit(record.exitCode) });
      const level = lifecycleLogLevel(record);
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    } catch {
      // Logging must never affect the container lifecycle.
    }
  }

  override async onStart(): Promise<void> {
    this.lifecycleStartedAt = Date.now();
    this.logLifecycle("container.start");
    await super.onStart();
  }

  override async onStop(params?: Parameters<SdkSandbox<Env>["onStop"]>[0]): Promise<void> {
    this.logLifecycle("container.stop", { stop: params ? { exitCode: params.exitCode, reason: params.reason } : null });
    this.lifecycleStartedAt = null;
    await super.onStop(params);
  }

  override onError(error: unknown): void {
    this.logLifecycle("container.error", { error });
    super.onError(error);
  }

  override async onActivityExpired(): Promise<void> {
    this.logLifecycle("container.activity_expired");
    await super.onActivityExpired();
  }
}

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    try {
      return await handleBridgeRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({
          error: "internal_error",
          message,
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
