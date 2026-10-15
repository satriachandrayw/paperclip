export function normalizeLeaseIdPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function buildLeaseSandboxId(input: {
  environmentId: string;
  runId: string;
  reuseLease: boolean;
  normalizeId: boolean;
  randomId?: string;
}): string {
  const base = input.reuseLease
    ? `pc-env-${input.environmentId}`
    : `pc-${input.runId}-${input.randomId ?? crypto.randomUUID().slice(0, 8)}`;
  return input.normalizeId ? normalizeLeaseIdPart(base) : base;
}

export function buildSentinelPath(remoteCwd: string): string {
  return `${remoteCwd.replace(/\/+$/, "")}/.paperclip-lease.json`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
