---
summary: "Cloudbath planning index for OpenClaw fork development"
read_when:
  - Planning Cloudbath work in the OpenClaw fork
  - Reviewing Cloudbath development boundaries before implementation
  - Checking which Cloudbath planning document to read next
title: Cloudbath Planning
---

# Cloudbath Planning

These notes prepare the `kerverme/cloudbath-openclaw` fork for future Cloudbath
experiments while preserving compatibility with upstream OpenClaw. They are
planning documents only; they do not implement LINE, Notion, deployment, or any
runtime behavior.

## Scope

Cloudbath development uses Codex Cloud and GitHub pull requests. No local Mac,
local folders, local terminal, local credentials, or other personal-computer
resources are required for this planning scope.

Future production hosting is expected to run on DigitalOcean, but this repository
change does not deploy infrastructure or expose endpoints.

## Principles

- Preserve compatibility with upstream OpenClaw.
- Prefer supported extension points over core modifications.
- Keep GitHub as the source-code and pull-request system.
- Use Codex Cloud for development and validation work.
- Run the future production instance on DigitalOcean.
- Start Notion access as read-only.
- Start LINE access with pairing or a strict allowlist.
- Do not publicly expose the OpenClaw control interface.
- Never commit secrets.
- Do not give LINE-originated sessions unrestricted shell or elevated access.

## Documents

- [Architecture plan](/cloudbath/ARCHITECTURE-PLAN)
- [Security baseline](/cloudbath/SECURITY-BASELINE)
- [Deployment plan](/cloudbath/DEPLOYMENT-PLAN)

## Placeholder environment file

`docs/cloudbath/.env.example` lists placeholder variable names only. Copy it to a
private deployment environment when a real deployment exists, then provide values
through the host secret manager or another private secret source. Do not commit
filled `.env` files.
