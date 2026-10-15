import { shellQuote } from "./helpers.js";

export const LIVE_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const KILL_GRACE_MS = 5_000;

export interface ExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
}

export interface ExecOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandScript {
  shell: string;
  pidFile: string;
}

export interface ExecProcessLike {
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export type OutputListener = (stream: "stdout" | "stderr", data: string) => void | Promise<void>;

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function randomToken(): string {
  return crypto.randomUUID().replace(/[^a-zA-Z0-9-]/g, "");
}

const PROFILE_LINES = [
  "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
  'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
];

export function buildCommandScript(request: ExecRequest, token = randomToken()): CommandScript {
  const env = request.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [request.command, ...(request.args ?? [])].map(shellQuote).join(" ");
  const target = envArgs.length > 0 ? `env ${envArgs.join(" ")} ${commandParts}` : commandParts;
  const pidFile = `/tmp/.paperclip-exec-${token}.pid`;
  const stdinRedirect = request.stdin ? "" : " </dev/null";
  const lines = [...PROFILE_LINES];
  if (request.cwd) {
    lines.push(`mkdir -p ${shellQuote(request.cwd)}`);
    lines.push(`cd ${shellQuote(request.cwd)} || exit 1`);
  }
  lines.push(`_pc_pid=${shellQuote(pidFile)}`);
  lines.push(
    `if command -v setsid >/dev/null 2>&1; then setsid -w sh -c 'echo "$$" >"$0"; exec "$@"' "$_pc_pid" ${target}${stdinRedirect}; ` +
      `else sh -c 'echo "$$" >"$0"; exec "$@"' "$_pc_pid" ${target}${stdinRedirect}; fi`,
  );
  lines.push('_pc_rc=$?; rm -f "$_pc_pid"; exit "$_pc_rc"');
  return { shell: lines.join("\n"), pidFile };
}

export function buildKillScript(): string[] {
  return [
    "/bin/sh",
    "-c",
    'p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] || exit 0\n' +
      'pkill -TERM -g "$p" 2>/dev/null || /bin/kill -s TERM -- "-$p" 2>/dev/null\n' +
      "sleep 2\n" +
      'pkill -KILL -g "$p" 2>/dev/null || /bin/kill -s KILL -- "-$p" 2>/dev/null\n' +
      "exit 0",
    "paperclip-kill",
  ];
}

interface StreamCollector {
  chunks: Uint8Array[];
  liveBytes: number;
  droppedBytes: number;
  reader?: ReadableStreamDefaultReader;
}

async function drain(
  stream: ReadableStream | null,
  name: "stdout" | "stderr",
  collector: StreamCollector,
  onOutput: OutputListener | undefined,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  collector.reader = reader;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  while (true) {
    let chunk: ReadableStreamReadResult<unknown>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    const { done, value } = chunk;
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    collector.chunks.push(bytes);
    if (!onOutput) continue;
    const room = LIVE_OUTPUT_LIMIT_BYTES - collector.liveBytes;
    if (room <= 0) {
      collector.droppedBytes += bytes.byteLength;
      continue;
    }
    const live = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
    collector.liveBytes += live.byteLength;
    collector.droppedBytes += bytes.byteLength - live.byteLength;
    const text = decoder.decode(live, { stream: true });
    if (text.length > 0) await onOutput(name, text);
  }
  if (onOutput) {
    const tail = decoder.decode();
    if (tail.length > 0) await onOutput(name, tail);
    if (collector.droppedBytes > 0) {
      await onOutput(
        "stderr",
        `\n[paperclip-bridge] live ${name} truncated after ${LIVE_OUTPUT_LIMIT_BYTES} bytes (${collector.droppedBytes} more); full output is in the result\n`,
      );
    }
  }
}

export function decodeBytes(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(merged);
}

export async function collectOutput(
  process: ExecProcessLike,
  options: {
    timeoutMs?: number;
    onOutput?: OutputListener;
    kill: () => Promise<void>;
    graceMs?: number;
  },
): Promise<ExecOutcome> {
  const stdout: StreamCollector = { chunks: [], liveBytes: 0, droppedBytes: 0 };
  const stderr: StreamCollector = { chunks: [], liveBytes: 0, droppedBytes: 0 };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  const abandon = () => {
    for (const collector of [stdout, stderr]) {
      void collector.reader?.cancel().catch(() => undefined);
    }
  };
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      void options.kill().catch(() => undefined);
      forceTimer = setTimeout(() => {
        try {
          process.kill(9);
        } catch {
          void 0;
        }
        abandonTimer = setTimeout(abandon, graceMs);
      }, graceMs);
    }, timeoutMs);
  }
  try {
    const exit = process.exitCode.then(
      (code) => code,
      () => -1,
    );
    const [exitCode] = await Promise.all([
      exit,
      drain(process.stdout, "stdout", stdout, options.onOutput),
      drain(process.stderr, "stderr", stderr, options.onOutput),
    ]);
    const stderrText = decodeBytes(stderr.chunks);
    return {
      exitCode: timedOut ? null : exitCode,
      signal: null,
      timedOut,
      stdout: decodeBytes(stdout.chunks),
      stderr: timedOut ? `${stderrText}Command timed out after ${timeoutMs}ms\n` : stderrText,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    if (abandonTimer) clearTimeout(abandonTimer);
  }
}
