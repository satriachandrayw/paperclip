# Cloudflare Sandbox Bridge Template

This Worker is the operator-facing bridge used by `@paperclipai/plugin-cloudflare-sandbox`.

It exposes a small authenticated JSON API under `/api/paperclip-sandbox/v1` and translates Paperclip lease and command requests into calls on a Durable Object that drives its container through `ctx.container` (Cloudflare Sandbox SDK 1.x).

## What it does

- health and probe
- acquire, resume, release, and destroy leases
- execute commands in the sandbox container, each as its own process group with a hard timeout
- stream raw file bytes into and out of a sandbox (`GET` and `PUT /files`), which the plugin uses for native workspace sync
- kill the whole process group of a timed-out command so Paperclip does not inherit wedged background processes
- log one structured record per container start and stop, with the exit code, so mid-run container restarts are visible in Workers observability

File transfer uses the SDK's `Files` helper, which needs `/usr/local/bin/sandbox-shim` in the image; the `Dockerfile` copies it from `cloudflare/sandbox` with the same version as the installed package. A bridge without the file route does not report `fileTransfer` on its leases. The plugin then marks those leases for the base64 fallback, so an old bridge keeps working with a new plugin.

## Prerequisites

1. Cloudflare account with Sandbox / Containers access
2. `wrangler` configured for that account
3. Docker running locally for `wrangler deploy`
4. A bridge auth token set as a Worker secret:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
```

## Local development

```bash
cd bridge-template
pnpm install --ignore-workspace --no-lockfile
pnpm test
pnpm typecheck
pnpm dev
```

## Deploy

```bash
pnpm deploy
```

After deploy, configure Paperclip with:

- `bridgeBaseUrl`: your Worker URL
- `bridgeAuthToken`: the same bearer token value stored in `BRIDGE_AUTH_TOKEN`

## Configuration

- `SANDBOX_INSTANCE_TYPE`: `lite`, `basic`, `standard-1` to `standard-4`, or a custom size such as `2vcpu,6144mib,12000mb`. Defaults to `standard-2`.
- `SANDBOX_ENABLE_INTERNET`: set to `false` to start containers without outbound Internet access.
- Each command runs as a separate process, so nothing carries over between commands. Pass the working directory and environment on every call; put image-wide settings such as `PATH` in `/etc/profile.d`, which the bridge sources before each command. `sessionStrategy` and `sessionId` are accepted and ignored.

## Upgrading from a 0.x bridge

The container application uses the `durable_object` scheduling policy, which cannot be applied to an existing application. Deploy this template as a new Worker (or give the container entry a new `name` and a new Durable Object class), point a new Paperclip environment at it, move agents over, and delete the old container application once no lease uses it.

## Notes

- `reuseLease: true` should only be used together with `keepAlive: true`
- `.workers.dev` is fine for bridge HTTP traffic, but preview/wildcard host flows are intentionally out of scope here
- keep the Docker image aligned with the installed `@cloudflare/sandbox` version
