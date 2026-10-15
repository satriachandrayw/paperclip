import { describe, expect, it, vi } from "vitest";
import { LIVE_OUTPUT_LIMIT_BYTES, buildCommandScript, buildKillScript, collectOutput, decodeBytes, type ExecProcessLike } from "./exec.js";

function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

function fakeProcess(input: { stdout?: ReadableStream | null; stderr?: ReadableStream | null; exitCode: Promise<number> }): ExecProcessLike & { kill: ReturnType<typeof vi.fn> } {
  return { stdout: input.stdout ?? null, stderr: input.stderr ?? null, exitCode: input.exitCode, kill: vi.fn() };
}

describe("buildCommandScript", () => {
  it("quotes every argument, sources login profiles and runs the command in its own process group", () => {
    const script = buildCommandScript(
      { command: "printf", args: ["%s|%s", "a b", "it's"], cwd: "/workspace/paperclip", env: { PAPERCLIP_FLAG: "1" } },
      "tok",
    );
    expect(script.pidFile).toBe("/tmp/.paperclip-exec-tok.pid");
    expect(script.shell).toContain(". /etc/profile");
    expect(script.shell).toContain("cd '/workspace/paperclip' || exit 1");
    expect(script.shell).toContain("setsid -w sh -c");
    expect(script.shell).toContain(`env PAPERCLIP_FLAG='1' 'printf' '%s|%s' 'a b' 'it'"'"'s'`);
    expect(script.shell).toContain("</dev/null");
  });

  it("keeps stdin attached when the request carries stdin", () => {
    const script = buildCommandScript({ command: "cat", stdin: "hello" }, "tok");
    expect(script.shell).not.toContain("</dev/null");
  });

  it("rejects environment keys that are not shell identifiers", () => {
    expect(() => buildCommandScript({ command: "true", env: { "BAD-KEY": "x" } })).toThrow(/Invalid sandbox environment variable key/);
  });

  it("runs as a real shell script with byte-exact output", async () => {
    const { execFileSync } = await import("node:child_process");
    const script = buildCommandScript({ command: "printf", args: ["a\\0b\\0c"], env: { X: "it's" } }, "unit");
    const out = execFileSync("/bin/sh", ["-c", script.shell, "paperclip-exec"]);
    expect([...out]).toEqual([0x61, 0, 0x62, 0, 0x63]);
  });
});

describe("collectOutput", () => {
  it("returns stdout, stderr and the exit code, preserving NUL bytes", async () => {
    const process = fakeProcess({
      stdout: streamOf(new Uint8Array([0x61, 0x00, 0x62])),
      stderr: streamOf("warn\n"),
      exitCode: Promise.resolve(3),
    });
    const result = await collectOutput(process, { kill: vi.fn() });
    expect(result).toEqual({ exitCode: 3, signal: null, timedOut: false, stdout: "a\0b", stderr: "warn\n" });
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("é✓");
    const process = fakeProcess({
      stdout: streamOf(bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)),
      exitCode: Promise.resolve(0),
    });
    const onOutput = vi.fn();
    const result = await collectOutput(process, { kill: vi.fn(), onOutput });
    expect(result.stdout).toBe("é✓");
    expect(onOutput.mock.calls.map((call) => call[1]).join("")).toBe("é✓");
  });

  it("caps live output but keeps the full result", async () => {
    const big = "x".repeat(LIVE_OUTPUT_LIMIT_BYTES + 10);
    const process = fakeProcess({ stdout: streamOf(big), exitCode: Promise.resolve(0) });
    const onOutput = vi.fn();
    const result = await collectOutput(process, { kill: vi.fn(), onOutput });
    expect(result.stdout.length).toBe(big.length);
    const live = onOutput.mock.calls.filter((call) => call[0] === "stdout").map((call) => call[1]).join("");
    expect(live.length).toBe(LIVE_OUTPUT_LIMIT_BYTES);
    expect(onOutput.mock.calls.some((call) => call[0] === "stderr" && /truncated after/.test(call[1]))).toBe(true);
  });

  it("kills the process group on timeout, then force-kills the exec process", async () => {
    vi.useFakeTimers();
    let resolveExit: (code: number) => void = () => undefined;
    const exitCode = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const process = fakeProcess({ exitCode });
    process.kill.mockImplementation(() => resolveExit(137));
    const kill = vi.fn().mockResolvedValue(undefined);
    const pending = collectOutput(process, { timeoutMs: 1000, kill, graceMs: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(process.kill).toHaveBeenCalledWith(9);
    const result = await pending;
    vi.useRealTimers();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out after 1000ms");
  });
});

describe("buildKillScript", () => {
  it("kills every process in the command's group under dash-compatible sh", async () => {
    const { spawn, execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const hasSetsid = (() => {
      try {
        execFileSync("sh", ["-c", "command -v setsid && command -v pkill"]);
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasSetsid) return;
    const dir = mkdtempSync(join(tmpdir(), "pc-kill-"));
    const pidFile = join(dir, "pid");
    const marker = `pc-kill-${Date.now()}`;
    const child = spawn(
      "setsid",
      ["-w", "sh", "-c", 'echo "$$" >"$0"; exec sh -c "sleep 300 & sleep 300" ' + marker, pidFile],
      { stdio: "ignore", detached: false },
    );
    for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 20));
    const pgid = readFileSync(pidFile, "utf8").trim();
    const count = () => execFileSync("sh", ["-c", `pgrep -g ${pgid} | wc -l`]).toString().trim();
    expect(Number(count())).toBeGreaterThanOrEqual(2);
    const [shell, flag, script, name] = buildKillScript();
    execFileSync(shell!, [flag!, script!, name!, pidFile]);
    await new Promise((resolve) => child.once("exit", resolve));
    expect(count()).toBe("0");
  }, 15_000);
});

describe("decodeBytes", () => {
  it("joins chunks before decoding", () => {
    expect(decodeBytes([new Uint8Array([0xe2, 0x9c]), new Uint8Array([0x93])])).toBe("✓");
  });
});
