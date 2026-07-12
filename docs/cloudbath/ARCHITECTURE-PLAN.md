---
summary: "Cloudbath architecture planning for future LINE, OpenClaw, and Notion integration"
read_when:
  - Planning the Cloudbath proof of concept
  - Deciding where Notion integration should live
  - Reviewing LINE message flow boundaries
title: Cloudbath Architecture Plan
---

# Cloudbath Architecture Plan

This page records a compatibility-first plan for future Cloudbath work in the
OpenClaw fork. It is intentionally documentation-only.

## Verified repository facts

- OpenClaw already has a LINE channel plugin under `extensions/line`.
- The LINE plugin is an official plugin installed separately as `@openclaw/line`.
- LINE inbound traffic is received by the Gateway webhook path and dispatched to
  the channel runtime after signature validation.
- LINE responses are routed back through the LINE channel delivery path.
- OpenClaw exposes supported extension mechanisms for plugins, skills, tools,
  MCP servers, channel plugins, and provider plugins.

## Future Cloudbath flow

The target proof of concept can be built as a composition of existing OpenClaw
surfaces:

1. A LINE user sends an allowed or paired message.
2. The LINE plugin validates the webhook signature and request body.
3. The LINE channel ingress path checks pairing, allowlists, group policy, and
   mention activation.
4. OpenClaw routes the message to the configured agent.
5. The agent uses a supported Notion integration surface to read authorized
   Notion database data.
6. The agent summarizes the requested information.
7. The LINE channel delivery path sends the reply to the originating LINE chat.

## Notion integration recommendation

Start Notion as a supported extension, not a core OpenClaw change.

Preferred order:

1. Use an MCP server if an adequate maintained Notion MCP server satisfies the
   read-only database requirements and can run safely in the deployment.
2. If MCP is not adequate, create an OpenClaw plugin that exposes a narrow
   read-only Notion tool surface.
3. Use a skill for prompt guidance, operating rules, and example workflows, but
   not as the sole integration when real Notion API access is required.
4. Avoid modifying OpenClaw core unless an upstream-compatible SDK or plugin
   seam is missing.

This keeps Cloudbath development aligned with upstream OpenClaw and makes later
rebases easier.

## Extension boundaries

- LINE behavior should remain owned by the LINE channel plugin.
- Notion API credentials and database policy should remain owned by the Notion
  integration surface.
- Agent instructions should describe what the agent may read and summarize.
- Core OpenClaw should remain plugin-agnostic.

## Compatibility guardrails

- Do not redesign OpenClaw around the LINE and Notion proof of concept.
- Do not add Cloudbath-specific defaults to core runtime paths.
- Do not remove existing channel, provider, tool, plugin, or skill behavior.
- Prefer additive plugin or MCP configuration over core configuration changes.
- Keep Cloudbath documentation easy to update or remove during upstream rebases.
