import { describe, expect, it } from "vitest";
import { buildLifecycleRecord, classifyExit, lifecycleLogLevel } from "./lifecycle.js";

describe("classifyExit", () => {
  it("names the common container exit codes", () => {
    expect(classifyExit(0)).toBe("clean_exit");
    expect(classifyExit(137)).toBe("sigkill_or_oom");
    expect(classifyExit(143)).toBe("sigterm");
    expect(classifyExit(139)).toBe("signal_11");
    expect(classifyExit(1)).toBe("nonzero_exit");
    expect(classifyExit(null)).toBeNull();
    expect(classifyExit(undefined)).toBeNull();
  });
});

describe("buildLifecycleRecord", () => {
  it("records exit code, reason and uptime for a stop", () => {
    const record = buildLifecycleRecord({
      event: "container.stop",
      durableObjectId: "do-1",
      sandboxName: "pc-run-1",
      stop: { exitCode: 137, reason: "runtime_signal" },
      startedAt: 1_000,
      now: 61_000,
    });
    expect(record).toMatchObject({
      bridgeLifecycle: "container.stop",
      durableObjectId: "do-1",
      sandboxName: "pc-run-1",
      exitCode: 137,
      reason: "runtime_signal",
      uptimeMs: 60_000,
      error: null,
    });
    expect(lifecycleLogLevel(record)).toBe("warn");
  });

  it("leaves uptime null when the start time is unknown (Durable Object was evicted)", () => {
    const record = buildLifecycleRecord({ event: "container.stop", durableObjectId: "do-1", stop: { exitCode: 0, reason: "exit" } });
    expect(record.uptimeMs).toBeNull();
    expect(record.sandboxName).toBeNull();
  });

  it("truncates error messages and logs errors at error level", () => {
    const record = buildLifecycleRecord({ event: "container.error", durableObjectId: "do-1", error: new Error("x".repeat(900)) });
    expect(record.error?.length).toBe(500);
    expect(lifecycleLogLevel(record)).toBe("error");
  });

  it("does not invent an exit code when the SDK passes none", () => {
    const record = buildLifecycleRecord({ event: "container.stop", durableObjectId: "do-1", stop: {} });
    expect(record.exitCode).toBeNull();
    expect(record.reason).toBeNull();
  });
});
