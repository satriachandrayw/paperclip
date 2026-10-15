import { DurableObject } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { buildLifecycleRecord, classifyExit, lifecycleLogLevel, type LifecycleEvent } from "./lifecycle.js";
import { buildCommandScript, buildKillScript, collectOutput, type ExecOutcome, type ExecRequest } from "./exec.js";

export const DEFAULT_INSTANCE_TYPE = "standard-2";
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STATE_KEY = "lease";

export type InstanceSetting =
  | "lite"
  | "basic"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { vcpu: number; memoryMib: number; diskMb: number };

export interface SandboxStartOptions {
  instance: InstanceSetting;
  inactivityTimeoutMs: number;
  enableInternet: boolean;
}

export interface LeaseState {
  startedAt: number;
  inactivityTimeoutMs: number;
}

export type FileReadResult =
  | { ok: true; body: ReadableStream<Uint8Array>; size: number | null }
  | { ok: false; missing: true };

export function parseDuration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^\s*(\d+)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.min(Math.max(amount * factor, 1000), MAX_INACTIVITY_TIMEOUT_MS);
}

export function parseInstanceSetting(value: string | undefined): InstanceSetting {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_INSTANCE_TYPE;
  if (["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"].includes(trimmed)) {
    return trimmed as InstanceSetting;
  }
  const custom = /^(\d+(?:\.\d+)?)\s*vcpu\s*[,/x ]\s*(\d+)\s*mib\s*[,/x ]\s*(\d+)\s*mb$/i.exec(trimmed);
  if (custom) {
    return { vcpu: Number(custom[1]), memoryMib: Number(custom[2]), diskMb: Number(custom[3]) };
  }
  throw new Error(`Unsupported SANDBOX_INSTANCE_TYPE: ${trimmed}`);
}

export interface SandboxEnv {
  SANDBOX_INSTANCE_TYPE?: string;
  SANDBOX_ENABLE_INTERNET?: string;
}

export class Sandbox extends DurableObject<SandboxEnv> {
  #files: Files | null = null;

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      ctx.blockConcurrencyWhile(async () => {
        const state = await ctx.storage.get<LeaseState>(STATE_KEY);
        await container.setInactivityTimeout(state?.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
        this.#watch(container);
      });
    }
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The Sandbox Durable Object has no container binding.");
    return container;
  }

  #fileApi(): Files {
    this.#files ??= new Files(this.#container());
    return this.#files;
  }

  #log(event: LifecycleEvent, extra: { exitCode?: number | null; reason?: string | null; error?: unknown; startedAt?: number | null } = {}) {
    try {
      const record = buildLifecycleRecord({
        event,
        durableObjectId: this.ctx.id.toString(),
        sandboxName: this.ctx.id.name ?? null,
        stop: { exitCode: extra.exitCode ?? null, reason: extra.reason ?? null },
        startedAt: extra.startedAt ?? null,
        error: extra.error,
      });
      const line = JSON.stringify({ ...record, exitClass: classifyExit(record.exitCode) });
      const level = lifecycleLogLevel(record);
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    } catch {
      return;
    }
  }

  #watch(container: Container) {
    const watchedAt = Date.now();
    this.ctx.waitUntil(
      container
        .monitor()
        .then(async () => {
          const state = await this.ctx.storage.get<LeaseState>(STATE_KEY);
          this.#log("container.stop", { exitCode: 0, reason: "exit", startedAt: state?.startedAt ?? watchedAt });
        })
        .catch(async (error: unknown) => {
          const state = await this.ctx.storage.get<LeaseState>(STATE_KEY);
          const exitCode = readExitCode(error);
          this.#log("container.stop", {
            exitCode,
            reason: exitCode === null ? "runtime_error" : "exit",
            error,
            startedAt: state?.startedAt ?? watchedAt,
          });
        }),
    );
  }

  async ensureStarted(options: SandboxStartOptions): Promise<{ started: boolean }> {
    const container = this.#container();
    if (container.running) {
      await container.setInactivityTimeout(options.inactivityTimeoutMs);
      await this.ctx.storage.put<LeaseState>(STATE_KEY, {
        startedAt: (await this.ctx.storage.get<LeaseState>(STATE_KEY))?.startedAt ?? Date.now(),
        inactivityTimeoutMs: options.inactivityTimeoutMs,
      });
      return { started: false };
    }
    const image = container.images.sandbox;
    if (!image) throw new Error("The container application has no image named 'sandbox'.");
    container.start({
      image,
      instance: options.instance,
      enableInternet: options.enableInternet,
      labels: { app: "paperclip-sandbox" },
    });
    await container.setInactivityTimeout(options.inactivityTimeoutMs);
    const startedAt = Date.now();
    await this.ctx.storage.put<LeaseState>(STATE_KEY, { startedAt, inactivityTimeoutMs: options.inactivityTimeoutMs });
    this.#log("container.start", { startedAt });
    this.#watch(container);
    return { started: true };
  }

  async isRunning(): Promise<boolean> {
    return this.ctx.container?.running === true;
  }

  async exec(request: ExecRequest): Promise<ExecOutcome> {
    const container = this.#container();
    if (!container.running) throw new SandboxNotRunningError();
    const script = buildCommandScript(request);
    const process = await container.exec(["/bin/sh", "-c", script.shell, "paperclip-exec"], {
      cwd: "/",
      stdin: request.stdin ? stringStream(request.stdin) : undefined,
    });
    return await collectOutput(process, {
      timeoutMs: request.timeoutMs,
      onOutput: undefined,
      kill: () => this.#killGroup(script.pidFile),
    });
  }

  async execStream(request: ExecRequest): Promise<ReadableStream<Uint8Array>> {
    const container = this.#container();
    if (!container.running) throw new SandboxNotRunningError();
    const script = buildCommandScript(request);
    const process = await container.exec(["/bin/sh", "-c", script.shell, "paperclip-exec"], {
      cwd: "/",
      stdin: request.stdin ? stringStream(request.stdin) : undefined,
    });
    const encoder = new TextEncoder();
    const kill = () => this.#killGroup(script.pidFile);
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: unknown) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15_000);
        try {
          const result = await collectOutput(process, {
            timeoutMs: request.timeoutMs,
            onOutput: (stream, data) => send(stream, { data }),
            kill,
          });
          send("complete", result);
        } catch (error) {
          send("error", { error: error instanceof Error ? error.message : String(error) });
        } finally {
          clearInterval(heartbeat);
          controller.close();
        }
      },
    });
  }

  async #killGroup(pidFile: string): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    try {
      const killer = await container.exec([...buildKillScript(), pidFile]);
      await killer.exitCode;
    } catch {
      return;
    }
  }

  async readFile(path: string): Promise<FileReadResult> {
    if (!this.ctx.container?.running) throw new SandboxNotRunningError();
    const files = this.#fileApi();
    try {
      const stat = await files.stat(path);
      const response = await files.readFile(path);
      if (!response.body) return { ok: true, body: new Response("").body!, size: 0 };
      return { ok: true, body: response.body, size: Number(stat.size) };
    } catch (error) {
      if (SandboxFileError.is(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { ok: false, missing: true };
      }
      throw error;
    }
  }

  async writeFile(path: string, body: ReadableStream<Uint8Array>): Promise<void> {
    if (!this.ctx.container?.running) throw new SandboxNotRunningError();
    const files = this.#fileApi();
    const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 1));
    await files.mkdir(parent, { recursive: true });
    await files.writeFile(path, body);
  }

  async destroy(reason = "lease released"): Promise<void> {
    await this.ctx.storage.delete(STATE_KEY);
    const container = this.ctx.container;
    if (container?.running) await container.destroy(reason);
  }
}

export class SandboxNotRunningError extends Error {
  constructor() {
    super("Cloudflare sandbox state is no longer available: the container is not running.");
    this.name = "SandboxNotRunningError";
  }
}

export function isSandboxNotRunningError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  return name === "SandboxNotRunningError" || /container is not running/i.test(message);
}

function readExitCode(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /exit(?:ed)?(?: with)?(?: code)?[:\s]+(-?\d+)/i.exec(message);
  return match ? Number(match[1]) : null;
}

function stringStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
