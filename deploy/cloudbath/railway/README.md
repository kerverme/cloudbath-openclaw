# Cloudbath Railway deployment

This directory contains the smallest Railway-specific deployment overlay for the
Cloudbath OpenClaw fork. It does not replace the upstream root `Dockerfile`.
Instead, `railway.json` points Railway at `deploy/cloudbath/railway/Dockerfile`.

## Why this Dockerfile exists

Railway validates BuildKit cache mount IDs before the Docker build starts. The
upstream OpenClaw Dockerfile uses explicit cache IDs such as
`id=openclaw-pnpm-store` and `id=openclaw-bookworm-apt-cache`. Railway requires
cache mount IDs to use its service cache-key prefix format, and environment
variables cannot be interpolated into cache mount IDs.

The Railway-specific Dockerfile preserves the upstream stages and commands, but
removes only those explicit cache `id=` attributes. The cache mounts keep their
same target paths and `sharing=locked` behavior so dependency installation, apt
package installation, build, runtime hardening, health checks, and persistence
behavior remain unchanged.

## Railway configuration

`railway.json` selects this Dockerfile and sets the deployment start and health
check settings:

- Builder: `DOCKERFILE`
- Dockerfile path: `deploy/cloudbath/railway/Dockerfile`
- Start command: `node openclaw.mjs gateway --allow-unconfigured --bind lan --port 8080`
- Health check path: `/health`
- Health check timeout: `300` seconds
- Restart policy: `ON_FAILURE`, max retries `10`

## Required Railway dashboard settings

### Public networking

Enable Railway **Public Networking** / **HTTP Proxy** for the service on port
`8080`. The start command binds OpenClaw to `lan` so Railway's proxy can reach
it inside the container.

### Persistent volume

Attach a Railway volume mounted at:

```text
/data
```

Use the environment variables below so OpenClaw state and workspace data survive
redeploys.

### Environment variables

Set these service variables in Railway. Use strong generated values for secrets;
never commit real values.

```dotenv
OPENCLAW_GATEWAY_PORT=8080
OPENCLAW_GATEWAY_TOKEN=<strong-random-admin-token>
OPENCLAW_STATE_DIR=/data/.openclaw
OPENCLAW_WORKSPACE_DIR=/data/workspace
```

Future Cloudbath integrations should add only placeholder-backed secrets until
implementation work begins:

```dotenv
MODEL_PROVIDER_API_KEY=<provider-api-key>
LINE_CHANNEL_ACCESS_TOKEN=<line-channel-access-token>
LINE_CHANNEL_SECRET=<line-channel-secret>
NOTION_TOKEN=<read-only-notion-token>
NOTION_CONSTRUCTION_DATABASE_ID=<authorized-notion-database-id>
```

## Control interface protection

The Gateway is reachable through Railway's public HTTPS proxy, so the shared
Gateway token is an administrative secret. Keep `OPENCLAW_GATEWAY_TOKEN` set,
do not publish it, and rotate it if it is exposed. Do not switch the Gateway to
unauthenticated mode for a public Railway service.

For future LINE-originated sessions, keep LINE pairing or strict sender
allowlists enabled and avoid granting unrestricted shell or elevated tools to
message-originated sessions.

## What this does not do

- It does not deploy anything.
- It does not connect LINE.
- It does not connect Notion.
- It does not change OpenClaw core runtime behavior.
- It does not modify the upstream root `Dockerfile`.
