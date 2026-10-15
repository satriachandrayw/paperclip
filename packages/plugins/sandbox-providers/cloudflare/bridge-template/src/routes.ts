import { isAuthorizedRequest } from "./auth.js";
import type { ExecOutcome, ExecRequest } from "./exec.js";
import { buildLeaseSandboxId, buildSentinelPath, shellQuote } from "./helpers.js";
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  MAX_INACTIVITY_TIMEOUT_MS,
  isSandboxNotRunningError,
  parseDuration,
  parseInstanceSetting,
  type FileReadResult,
  type SandboxStartOptions,
} from "./sandbox.js";

export const API_PREFIX = "/api/paperclip-sandbox/v1";
export const FILES_ROUTE = `${API_PREFIX}/files`;
export const DEFAULT_REMOTE_CWD = "/workspace/paperclip";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const BRIDGE_VERSION = "1.0.0";

export interface SandboxStub {
  ensureStarted(options: SandboxStartOptions): Promise<{ started: boolean }>;
  isRunning(): Promise<boolean>;
  exec(request: ExecRequest): Promise<ExecOutcome>;
  execStream(request: ExecRequest): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string): Promise<FileReadResult>;
  writeFile(path: string, body: ReadableStream<Uint8Array>): Promise<void>;
  destroy(reason?: string): Promise<void>;
}

export interface BridgeEnv {
  Sandbox: { getByName(name: string): SandboxStub };
  BRIDGE_AUTH_TOKEN?: string;
  SANDBOX_INSTANCE_TYPE?: string;
  SANDBOX_ENABLE_INTERNET?: string;
}

interface LeaseRequestBody {
  environmentId?: string;
  runId?: string;
  issueId?: string | null;
  providerLeaseId?: string;
  requestedCwd?: string;
  reuseLease?: boolean;
  keepAlive?: boolean;
  sleepAfter?: string;
  normalizeId?: boolean;
  sessionStrategy?: string;
  sessionId?: string;
  timeoutMs?: number;
}

interface ExecuteRequestBody {
  providerLeaseId?: string;
  command?: string;
  args?: unknown[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  streamOutput?: boolean;
}

export function toJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function toErrorResponse(status: number, error: string, message: string, details?: unknown): Response {
  return toJsonResponse({ error, message, details }, status);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function validateSandboxFilePath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.includes("\0")) return null;
  if (value.split("/").some((segment) => segment === "..")) return null;
  return value;
}

export function startOptionsFor(env: BridgeEnv, body: { keepAlive?: boolean; sleepAfter?: string }): SandboxStartOptions {
  const keepAlive = readBoolean(body.keepAlive, false);
  return {
    instance: parseInstanceSetting(env.SANDBOX_INSTANCE_TYPE),
    inactivityTimeoutMs: keepAlive
      ? MAX_INACTIVITY_TIMEOUT_MS
      : parseDuration(body.sleepAfter, DEFAULT_INACTIVITY_TIMEOUT_MS),
    enableInternet: env.SANDBOX_ENABLE_INTERNET !== "false",
  };
}

function stateLost(providerLeaseId: string): Response {
  return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox state is no longer available.", { providerLeaseId });
}

async function runUtility(sandbox: SandboxStub, action: string, script: string, timeoutMs: number): Promise<void> {
  const result = await sandbox.exec({ command: "sh", args: ["-c", script], cwd: "/", timeoutMs });
  if (result.timedOut) throw new Error(`${action} timed out: ${result.stderr.trim()}`);
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed with exit code ${result.exitCode ?? "null"}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
}

async function prepareWorkspace(
  sandbox: SandboxStub,
  input: { providerLeaseId: string; remoteCwd: string; resumedLease: boolean; timeoutMs: number; metadata: Record<string, unknown> },
): Promise<void> {
  const sentinel = JSON.stringify(
    { provider: "cloudflare", providerLeaseId: input.providerLeaseId, remoteCwd: input.remoteCwd, resumedLease: input.resumedLease, ...input.metadata, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  await runUtility(
    sandbox,
    `prepare workspace ${input.remoteCwd}`,
    `mkdir -p ${shellQuote(input.remoteCwd)} && printf '%s\\n' ${shellQuote(sentinel)} > ${shellQuote(buildSentinelPath(input.remoteCwd))}`,
    input.timeoutMs,
  );
}

function leaseMetadata(input: {
  providerLeaseId: string;
  remoteCwd: string;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  resumedLease: boolean;
}) {
  return {
    provider: "cloudflare",
    remoteCwd: input.remoteCwd,
    sandboxId: input.providerLeaseId,
    sessionStrategy: "default",
    keepAlive: input.keepAlive,
    sleepAfter: input.sleepAfter,
    normalizeId: input.normalizeId,
    resumedLease: input.resumedLease,
    fileTransfer: true,
    sandboxSdk: "1.x",
  };
}

async function handleProbe(env: BridgeEnv, body: LeaseRequestBody): Promise<Response> {
  const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
  const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
  const sandboxId = buildLeaseSandboxId({ environmentId: "probe", runId: `probe-${Date.now()}`, reuseLease: false, normalizeId: true });
  const sandbox = env.Sandbox.getByName(sandboxId);
  try {
    await sandbox.ensureStarted(startOptionsFor(env, body));
    await runUtility(sandbox, `ensure workspace ${remoteCwd}`, `mkdir -p ${shellQuote(remoteCwd)}`, timeoutMs);
    const result = await sandbox.exec({ command: "pwd", cwd: remoteCwd, timeoutMs });
    return toJsonResponse({
      ok: true,
      summary: "Connected to Cloudflare sandbox bridge.",
      metadata: { provider: "cloudflare", remoteCwd, stdout: result.stdout, sandboxSdk: "1.x" },
    });
  } finally {
    await sandbox.destroy("probe finished").catch(() => undefined);
  }
}

async function handleAcquire(env: BridgeEnv, body: LeaseRequestBody): Promise<Response> {
  if (!body.environmentId || !body.runId) {
    return toErrorResponse(400, "invalid_request", "environmentId and runId are required.");
  }
  const reuseLease = readBoolean(body.reuseLease, false);
  const keepAlive = readBoolean(body.keepAlive, false);
  const sleepAfter = readString(body.sleepAfter, "10m");
  const normalizeId = readBoolean(body.normalizeId, true);
  const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
  const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
  const providerLeaseId = buildLeaseSandboxId({ environmentId: body.environmentId, runId: body.runId, reuseLease, normalizeId });
  const sandbox = env.Sandbox.getByName(providerLeaseId);
  const metadata = leaseMetadata({ providerLeaseId, remoteCwd, keepAlive, sleepAfter, normalizeId, resumedLease: false });
  try {
    await sandbox.ensureStarted(startOptionsFor(env, body));
    await prepareWorkspace(sandbox, { providerLeaseId, remoteCwd, resumedLease: false, timeoutMs, metadata });
  } catch (error) {
    if (!reuseLease) await sandbox.destroy("lease acquire failed").catch(() => undefined);
    throw error;
  }
  return toJsonResponse({ providerLeaseId, metadata });
}

async function handleResume(env: BridgeEnv, body: LeaseRequestBody): Promise<Response> {
  if (!body.providerLeaseId) {
    return toErrorResponse(400, "invalid_request", "providerLeaseId is required.");
  }
  const providerLeaseId = body.providerLeaseId;
  const keepAlive = readBoolean(body.keepAlive, false);
  const sleepAfter = readString(body.sleepAfter, "10m");
  const normalizeId = readBoolean(body.normalizeId, true);
  const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
  const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
  const sandbox = env.Sandbox.getByName(providerLeaseId);
  if (!(await sandbox.isRunning())) return stateLost(providerLeaseId);
  const sentinel = await sandbox.exec({
    command: "sh",
    args: ["-c", `test -s ${shellQuote(buildSentinelPath(remoteCwd))}`],
    cwd: "/",
    timeoutMs,
  });
  if (sentinel.timedOut || sentinel.exitCode !== 0) return stateLost(providerLeaseId);
  await sandbox.ensureStarted(startOptionsFor(env, body));
  const metadata = leaseMetadata({ providerLeaseId, remoteCwd, keepAlive, sleepAfter, normalizeId, resumedLease: true });
  await prepareWorkspace(sandbox, { providerLeaseId, remoteCwd, resumedLease: true, timeoutMs, metadata });
  return toJsonResponse({ providerLeaseId, metadata });
}

async function handleDestroy(env: BridgeEnv, providerLeaseId: string, reason: string): Promise<Response> {
  try {
    await env.Sandbox.getByName(providerLeaseId).destroy(reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "sandbox.destroy.failed", providerLeaseId, error: message }));
    return toErrorResponse(502, "sandbox_destroy_failed", `Sandbox teardown failed: ${message}`, { providerLeaseId });
  }
  return toJsonResponse({ ok: true });
}

function readExecRequest(body: ExecuteRequestBody): ExecRequest {
  return {
    command: body.command!,
    args: Array.isArray(body.args) ? body.args.filter((value): value is string => typeof value === "string") : [],
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    env: body.env,
    stdin: typeof body.stdin === "string" && body.stdin.length > 0 ? body.stdin : null,
    timeoutMs: readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

async function handleExec(env: BridgeEnv, body: ExecuteRequestBody): Promise<Response> {
  if (!body.providerLeaseId || !body.command) {
    return toErrorResponse(400, "invalid_request", "providerLeaseId and command are required.");
  }
  const sandbox = env.Sandbox.getByName(body.providerLeaseId);
  const request = readExecRequest(body);
  console.log(JSON.stringify({ route: "exec", providerLeaseId: body.providerLeaseId, command: request.command, stream: body.streamOutput === true }));
  try {
    if (body.streamOutput === true) {
      const stream = await sandbox.execStream(request);
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    return toJsonResponse(await sandbox.exec(request));
  } catch (error) {
    if (isSandboxNotRunningError(error)) return stateLost(body.providerLeaseId);
    throw error;
  }
}

async function handleFiles(request: Request, env: BridgeEnv, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return toErrorResponse(405, "method_not_allowed", "Use GET to read a sandbox file or PUT to write one.");
  }
  const providerLeaseId = url.searchParams.get("providerLeaseId")?.trim() ?? "";
  const filePath = validateSandboxFilePath(url.searchParams.get("path"));
  if (!providerLeaseId || !filePath) {
    return toErrorResponse(400, "invalid_request", "providerLeaseId and an absolute path without '..' segments are required.");
  }
  console.log(JSON.stringify({ route: "files", method: request.method, providerLeaseId, path: filePath }));
  const sandbox = env.Sandbox.getByName(providerLeaseId);
  try {
    if (request.method === "GET") {
      const file = await sandbox.readFile(filePath);
      if (!file.ok) return toErrorResponse(404, "file_not_found", `No sandbox file at ${filePath}.`);
      const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (file.size !== null) headers["X-File-Size"] = String(file.size);
      return new Response(file.body, { status: 200, headers });
    }
    if (!request.body) return toErrorResponse(400, "invalid_request", "A request body is required.");
    await sandbox.writeFile(filePath, request.body);
    return toJsonResponse({ ok: true, path: filePath });
  } catch (error) {
    if (isSandboxNotRunningError(error)) return stateLost(providerLeaseId);
    throw error;
  }
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export async function handleBridgeRequest(request: Request, env: BridgeEnv): Promise<Response> {
  if (!(await isAuthorizedRequest(request, env.BRIDGE_AUTH_TOKEN))) {
    return toErrorResponse(401, "unauthorized", "Missing or invalid bridge bearer token.");
  }
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (request.method === "GET" && pathname === `${API_PREFIX}/health`) {
    return toJsonResponse({
      ok: true,
      provider: "cloudflare",
      bridgeVersion: BRIDGE_VERSION,
      capabilities: { reuseLease: true, namedSessions: false, previewUrls: false, fileTransfer: true },
    });
  }
  if (request.method === "POST" && pathname === `${API_PREFIX}/probe`) {
    return await handleProbe(env, await readJson<LeaseRequestBody>(request));
  }
  if (request.method === "POST" && pathname === `${API_PREFIX}/leases/acquire`) {
    return await handleAcquire(env, await readJson<LeaseRequestBody>(request));
  }
  if (request.method === "POST" && pathname === `${API_PREFIX}/leases/resume`) {
    return await handleResume(env, await readJson<LeaseRequestBody>(request));
  }
  if (request.method === "POST" && pathname === `${API_PREFIX}/leases/release`) {
    const body = await readJson<LeaseRequestBody>(request);
    if (!body.providerLeaseId || readBoolean(body.reuseLease, false)) return toJsonResponse({ ok: true });
    return await handleDestroy(env, body.providerLeaseId, "lease released");
  }
  if (request.method === "DELETE" && pathname.startsWith(`${API_PREFIX}/leases/`)) {
    const providerLeaseId = decodeURIComponent(pathname.split("/").pop() ?? "");
    if (!providerLeaseId) return toErrorResponse(400, "invalid_request", "providerLeaseId path parameter is required.");
    return await handleDestroy(env, providerLeaseId, "lease destroyed");
  }
  if (request.method === "POST" && pathname === `${API_PREFIX}/exec`) {
    return await handleExec(env, await readJson<ExecuteRequestBody>(request));
  }
  if (pathname === FILES_ROUTE) {
    return await handleFiles(request, env, url);
  }
  return toErrorResponse(404, "not_found", `No bridge route matched ${request.method} ${pathname}.`);
}
