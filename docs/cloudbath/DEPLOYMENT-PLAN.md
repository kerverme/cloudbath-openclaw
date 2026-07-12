---
summary: "Cloudbath DigitalOcean deployment planning for future OpenClaw work"
read_when:
  - Planning a future DigitalOcean OpenClaw deployment
  - Separating development, GitHub, and production responsibilities
  - Reviewing minimum production requirements
title: Cloudbath Deployment Plan
---

# Cloudbath Deployment Plan

This page records the future deployment direction for Cloudbath. It does not
create infrastructure, publish endpoints, or change release configuration.

## Responsibilities

- Codex Cloud: repository edits, validation, and pull-request preparation.
- GitHub: source code, reviews, pull requests, and branch history.
- DigitalOcean: future production host for the OpenClaw Gateway and required
  runtime services.
- Local Mac: not required for this development or deployment model.

## Minimum DigitalOcean requirements

A later production deployment should provide:

- A supported Node.js runtime matching the repository engine requirement.
- The pinned package manager declared by the repository.
- Persistent storage for OpenClaw state.
- Private secret injection for Gateway, model provider, LINE, and Notion values.
- HTTPS ingress for the LINE webhook path.
- Operator-only access to the OpenClaw Gateway and control interface.
- Log collection that redacts secrets and avoids storing full credential values.
- A rollback path to the previous known-good deployment.

## Network plan

- Public internet: expose only the LINE webhook path needed by LINE Messaging
  API.
- Operator access: keep Gateway control surfaces private and reachable only by a
  trusted operator path.
- Notion API: outbound HTTPS only, using a read-only token.
- Model provider API: outbound HTTPS only, using the configured provider key.

## Deployment sequence for a later task

1. Choose a DigitalOcean host shape and operating system.
2. Install the repository-required Node.js and package manager versions.
3. Configure private secret injection.
4. Install or build OpenClaw from a reviewed GitHub ref.
5. Configure the LINE plugin with pairing or strict allowlists.
6. Configure the Notion integration as read-only.
7. Verify the Gateway starts without exposing the control interface publicly.
8. Verify LINE webhook signature handling with a test channel.
9. Verify a read-only Notion database query through the selected extension
   mechanism.
10. Record evidence in the pull request or deployment runbook.

## Non-goals for this task

- No DigitalOcean deployment.
- No public endpoint exposure.
- No real credentials.
- No LINE implementation changes.
- No Notion implementation changes.
- No release configuration changes.
