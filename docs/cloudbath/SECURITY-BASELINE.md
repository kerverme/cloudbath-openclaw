---
summary: "Cloudbath security baseline for future OpenClaw LINE and Notion work"
read_when:
  - Reviewing Cloudbath security assumptions
  - Preparing LINE or Notion credentials
  - Planning DigitalOcean exposure and access controls
title: Cloudbath Security Baseline
---

# Cloudbath Security Baseline

This baseline defines minimum security constraints for future Cloudbath work. It
does not add credentials, deploy infrastructure, or change runtime behavior.

## Trust model

Cloudbath should treat the OpenClaw Gateway as trusted operator infrastructure,
not as a public multi-tenant service. LINE users are remote message senders and
must not automatically become unrestricted operators of the host.

## Secrets

- Never commit real credentials, tokens, database IDs, private keys, session
  files, or generated secret material.
- Keep `docs/cloudbath/.env.example` placeholder-only.
- Store real values in the DigitalOcean deployment environment or another
  private secret manager.
- Rotate credentials if they are ever pasted into logs, commits, issues, pull
  requests, screenshots, or chat transcripts.

## LINE access

- Start with pairing or a strict allowlist.
- Keep group access disabled or allowlisted until a specific group policy is
  approved.
- Do not use `dmPolicy: "open"` for production unless the risk is explicitly
  accepted and scoped.
- Verify LINE webhook signatures before processing events.
- Treat LINE user, group, and room IDs as sensitive operational identifiers.

## Notion access

- Start with read-only Notion access.
- Limit the Notion token to the minimum workspace pages or databases required.
- Restrict the first proof of concept to the authorized construction database.
- Do not allow arbitrary Notion writes, sharing changes, exports, or workspace
  enumeration until a separate security review approves them.

## Agent capability limits

LINE-originated sessions must not receive unrestricted shell, filesystem,
network, or elevated host access. Any future tools exposed to LINE-originated
sessions should be read-only by default, scoped to explicit data sources, and
observable in logs.

## Control interface exposure

The OpenClaw control interface must not be publicly exposed. Put it behind
private networking, SSH tunneling, a trusted proxy, or another operator-only
access path. Public ingress should be limited to the minimum webhook endpoint
needed for LINE.

## Audit checklist before implementation

- Confirm every public endpoint has a reason to be public.
- Confirm Gateway/control access is operator-only.
- Confirm LINE access is pairing-based or allowlisted.
- Confirm Notion token scope is read-only and database-limited.
- Confirm no secret values appear in Git history or pull-request text.
- Confirm LINE-originated sessions cannot invoke unrestricted shell or elevated
  tools.
