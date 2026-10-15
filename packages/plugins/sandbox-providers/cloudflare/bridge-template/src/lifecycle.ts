/**
 * Container lifecycle logging for diagnosing mid-run container restarts.
 *
 * The Sandbox SDK (0.12.x) only logs container stops at debug level, which
 * Workers observability does not keep. These helpers build one structured,
 * warn/error-level record per lifecycle event so each stop's exit code,
 * reason and uptime are queryable. Nothing here changes container behaviour.
 */

export type LifecycleEvent = "container.start" | "container.stop" | "container.error" | "container.activity_expired";

export interface StopInfo {
  exitCode?: number | null;
  reason?: string | null;
}

export interface LifecycleRecord {
  bridgeLifecycle: LifecycleEvent;
  durableObjectId: string;
  sandboxName: string | null;
  exitCode: number | null;
  reason: string | null;
  uptimeMs: number | null;
  error: string | null;
  at: string;
}

/** Exit code 137 = SIGKILL (often OOM), 143 = SIGTERM. */
export function classifyExit(exitCode: number | null | undefined): string | null {
  if (exitCode === null || exitCode === undefined) return null;
  if (exitCode === 0) return "clean_exit";
  if (exitCode === 137) return "sigkill_or_oom";
  if (exitCode === 143) return "sigterm";
  if (exitCode > 128) return `signal_${exitCode - 128}`;
  return "nonzero_exit";
}

export function buildLifecycleRecord(input: {
  event: LifecycleEvent;
  durableObjectId: string;
  sandboxName?: string | null;
  stop?: StopInfo | null;
  startedAt?: number | null;
  now?: number;
  error?: unknown;
}): LifecycleRecord {
  const now = input.now ?? Date.now();
  const error =
    input.error === undefined || input.error === null
      ? null
      : input.error instanceof Error
        ? `${input.error.name}: ${input.error.message}`.slice(0, 500)
        : String(input.error).slice(0, 500);
  return {
    bridgeLifecycle: input.event,
    durableObjectId: input.durableObjectId,
    sandboxName: input.sandboxName ?? null,
    exitCode: typeof input.stop?.exitCode === "number" ? input.stop.exitCode : null,
    reason: input.stop?.reason ?? null,
    uptimeMs: typeof input.startedAt === "number" ? Math.max(0, now - input.startedAt) : null,
    error,
    at: new Date(now).toISOString(),
  };
}

export function lifecycleLogLevel(record: LifecycleRecord): "info" | "warn" | "error" {
  if (record.bridgeLifecycle === "container.error") return "error";
  if (record.bridgeLifecycle === "container.stop") return "warn";
  return "info";
}
