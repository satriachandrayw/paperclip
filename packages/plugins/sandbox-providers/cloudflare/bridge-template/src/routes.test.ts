import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sandbox.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./sandbox.js").catch(() => ({}));
  return {
    ...actual,
    DEFAULT_INACTIVITY_TIMEOUT_MS: 600_000,
    MAX_INACTIVITY_TIMEOUT_MS: 21_600_000,
    parseDuration: (value: string | undefined, fallback: number) => (value === "15m" ? 900_000 : fallback),
    parseInstanceSetting: (value: string | undefined) => value ?? "standard-2",
    isSandboxNotRunningError: (error: unknown) => (error as { name?: string })?.name === "SandboxNotRunningError",
  };
});

import { handleBridgeRequest, startOptionsFor, validateSandboxFilePath, type BridgeEnv, type SandboxStub } from "./routes.js";

function stub(overrides: Partial<SandboxStub> = {}): SandboxStub & Record<string, ReturnType<typeof vi.fn>> {
  return {
    ensureStarted: vi.fn().mockResolvedValue({ started: true }),
    isRunning: vi.fn().mockResolvedValue(true),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "/workspace/paperclip\n", stderr: "" }),
    execStream: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

function envWith(sandbox: SandboxStub): BridgeEnv & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    BRIDGE_AUTH_TOKEN: "secret-token",
    Sandbox: {
      getByName: (name: string) => {
        names.push(name);
        return sandbox;
      },
    },
  };
}

function post(pathname: string, body: unknown, token = "secret-token"): Request {
  return new Request(`https://bridge.example.test/api/paperclip-sandbox/v1${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bridge routes on Sandbox SDK 1.x", () => {
  let sandbox: ReturnType<typeof stub>;
  let env: ReturnType<typeof envWith>;

  beforeEach(() => {
    sandbox = stub();
    env = envWith(sandbox);
  });

  it("rejects requests without the bearer token", async () => {
    const response = await handleBridgeRequest(post("/probe", {}, "wrong"), env);
    expect(response.status).toBe(401);
  });

  it("reports health without named sessions", async () => {
    const response = await handleBridgeRequest(
      new Request("https://bridge.example.test/api/paperclip-sandbox/v1/health", { headers: { Authorization: "Bearer secret-token" } }),
      env,
    );
    const body = (await response.json()) as { capabilities: Record<string, boolean>; bridgeVersion: string };
    expect(body.bridgeVersion).toBe("1.0.0");
    expect(body.capabilities).toMatchObject({ namedSessions: false, fileTransfer: true });
  });

  it("acquires a lease: starts the container, writes the sentinel and reports file transfer", async () => {
    const response = await handleBridgeRequest(
      post("/leases/acquire", { environmentId: "env-1", runId: "Run_ABC", requestedCwd: "/workspace/paperclip", sleepAfter: "15m", sessionStrategy: "named", sessionId: "paperclip" }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providerLeaseId: string; metadata: Record<string, unknown> };
    expect(body.providerLeaseId).toMatch(/^pc-run-abc-[a-z0-9]{8}$/);
    expect(env.names).toEqual([body.providerLeaseId]);
    expect(sandbox.ensureStarted).toHaveBeenCalledWith({ instance: "standard-2", inactivityTimeoutMs: 900_000, enableInternet: true });
    const utility = sandbox.exec.mock.calls[0]?.[0] as { args: string[] };
    expect(utility.args[1]).toContain("/workspace/paperclip/.paperclip-lease.json");
    expect(body.metadata).toMatchObject({ fileTransfer: true, remoteCwd: "/workspace/paperclip", resumedLease: false });
  });

  it("destroys the container when acquire setup fails", async () => {
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "read-only" });
    await expect(handleBridgeRequest(post("/leases/acquire", { environmentId: "e", runId: "r" }), env)).rejects.toThrow(/read-only/);
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });

  it("returns 409 on resume when the container stopped", async () => {
    sandbox.isRunning.mockResolvedValue(false);
    const response = await handleBridgeRequest(post("/leases/resume", { providerLeaseId: "pc-run-1-abcd1234" }), env);
    expect(response.status).toBe(409);
    expect(sandbox.ensureStarted).not.toHaveBeenCalled();
  });

  it("returns 409 on resume when the sentinel is missing", async () => {
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "" });
    const response = await handleBridgeRequest(post("/leases/resume", { providerLeaseId: "pc-run-1-abcd1234" }), env);
    expect(response.status).toBe(409);
  });

  it("releases by destroying the container and keeps reusable leases", async () => {
    expect((await handleBridgeRequest(post("/leases/release", { providerLeaseId: "pc-x", reuseLease: true }), env)).status).toBe(200);
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect((await handleBridgeRequest(post("/leases/release", { providerLeaseId: "pc-x" }), env)).status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledWith("lease released");
  });

  it("reports a failed teardown as 502", async () => {
    sandbox.destroy.mockRejectedValue(new Error("boom"));
    const response = await handleBridgeRequest(post("/leases/release", { providerLeaseId: "pc-x" }), env);
    expect(response.status).toBe(502);
  });

  it("execs with args, cwd, env and stdin, ignoring session fields", async () => {
    const response = await handleBridgeRequest(
      post("/exec", { providerLeaseId: "pc-x", command: "git", args: ["status", 5], cwd: "/w", env: { A: "1" }, stdin: "in", timeoutMs: 1234, sessionStrategy: "named", sessionId: "paperclip-bridge" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(sandbox.exec).toHaveBeenCalledWith({ command: "git", args: ["status"], cwd: "/w", env: { A: "1" }, stdin: "in", timeoutMs: 1234 });
  });

  it("maps a stopped container on exec to 409 sandbox_state_lost", async () => {
    sandbox.exec.mockRejectedValue(Object.assign(new Error("not running"), { name: "SandboxNotRunningError" }));
    const response = await handleBridgeRequest(post("/exec", { providerLeaseId: "pc-x", command: "true" }), env);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("sandbox_state_lost");
  });

  it("streams exec output as server-sent events", async () => {
    sandbox.execStream.mockResolvedValue(new Response("event: complete\ndata: {}\n\n").body);
    const response = await handleBridgeRequest(post("/exec", { providerLeaseId: "pc-x", command: "true", streamOutput: true }), env);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await response.text()).toContain("event: complete");
  });

  it("serves file reads with the size header and 404 for missing files", async () => {
    sandbox.readFile.mockResolvedValueOnce({ ok: true, body: new Response("abc").body, size: 3 });
    const url = "https://bridge.example.test/api/paperclip-sandbox/v1/files?providerLeaseId=pc-x&path=%2Ftmp%2Fa";
    const ok = await handleBridgeRequest(new Request(url, { headers: { Authorization: "Bearer secret-token" } }), env);
    expect(ok.headers.get("X-File-Size")).toBe("3");
    expect(await ok.text()).toBe("abc");
    sandbox.readFile.mockResolvedValueOnce({ ok: false, missing: true });
    const missing = await handleBridgeRequest(new Request(url, { headers: { Authorization: "Bearer secret-token" } }), env);
    expect(missing.status).toBe(404);
  });

  it("writes uploaded bytes and rejects traversal paths", async () => {
    const put = (path: string) =>
      new Request(`https://bridge.example.test/api/paperclip-sandbox/v1/files?providerLeaseId=pc-x&path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { Authorization: "Bearer secret-token" },
        body: "bytes",
      });
    expect((await handleBridgeRequest(put("/workspace/a.bin"), env)).status).toBe(200);
    expect(sandbox.writeFile).toHaveBeenCalledWith("/workspace/a.bin", expect.any(ReadableStream));
    expect((await handleBridgeRequest(put("/workspace/../etc/passwd"), env)).status).toBe(400);
  });

  it("probes with a throwaway container and destroys it", async () => {
    const response = await handleBridgeRequest(post("/probe", { requestedCwd: "/workspace/paperclip" }), env);
    expect(response.status).toBe(200);
    expect(env.names[0]).toMatch(/^pc-probe-/);
    expect(sandbox.destroy).toHaveBeenCalledWith("probe finished");
  });
});

describe("helpers", () => {
  it("keepAlive maps to the maximum inactivity timeout", () => {
    expect(startOptionsFor({ Sandbox: { getByName: vi.fn() } } as never, { keepAlive: true }).inactivityTimeoutMs).toBe(21_600_000);
    expect(startOptionsFor({ Sandbox: { getByName: vi.fn() }, SANDBOX_ENABLE_INTERNET: "false" } as never, {}).enableInternet).toBe(false);
  });

  it("validates sandbox file paths", () => {
    expect(validateSandboxFilePath("/tmp/x")).toBe("/tmp/x");
    expect(validateSandboxFilePath("tmp/x")).toBeNull();
    expect(validateSandboxFilePath("/tmp/../x")).toBeNull();
    expect(validateSandboxFilePath("/tmp/\0")).toBeNull();
  });
});
