/**
 * The seam a channel plugin uses to restrict an UNCONFIGURED group.
 *
 * Group tool policy is opt-in: with no `tools` entry for a group,
 * `resolveChannelGroupToolsPolicy` returns undefined and the session keeps the
 * agent's whole tool surface. For channels whose groups are created by whoever
 * adds the bot, the plugin has to supply a baseline instead, and that only
 * helps if a plugin-returned policy actually reaches tool filtering ahead of
 * (absent) config. These tests pin that path generically — no channel plugin is
 * imported here; the LINE baseline that uses it is tested in its own package.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { filterToolsByPolicy, resolveGroupToolPolicy } from "./agent-tools.policy.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

vi.mock("../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversation: ({ rawId }: { rawId: string }) => ({
    id: rawId,
    threadId: undefined,
    baseConversationId: rawId,
    parentConversationCandidates: [],
  }),
}));

const BASELINE_DENY = ["exec", "sessions_history", "memory_search"];
const GROUP_ID = "cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SESSION_KEY = `agent:main:whatsapp:group:${GROUP_ID}`;

/** A channel plugin that denies a baseline set for groups config never mentions. */
function installPluginWithBaseline(resolveToolPolicy: () => { deny: string[] } | undefined) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        plugin: {
          ...createOutboundTestPlugin({ id: "whatsapp", outbound: { deliveryMode: "direct" } }),
          groups: { resolveToolPolicy },
        },
        source: "test",
      },
    ]),
  );
}

describe("a plugin baseline restricts a group that config never mentions", () => {
  it("returns the plugin policy when no group config exists", () => {
    installPluginWithBaseline(() => ({ deny: [...BASELINE_DENY] }));

    const policy = resolveGroupToolPolicy({
      config: { channels: { whatsapp: {} } } as OpenClawConfig,
      sessionKey: SESSION_KEY,
      messageProvider: "whatsapp",
    });

    expect(policy?.deny).toEqual(BASELINE_DENY);
  });

  it("actually removes those tools from the session's tool list", () => {
    installPluginWithBaseline(() => ({ deny: [...BASELINE_DENY] }));
    const policy = resolveGroupToolPolicy({
      config: { channels: { whatsapp: {} } } as OpenClawConfig,
      sessionKey: SESSION_KEY,
      messageProvider: "whatsapp",
    });

    const tools = filterToolsByPolicy(
      [
        createStubTool("exec"),
        createStubTool("sessions_history"),
        createStubTool("memory_search"),
        createStubTool("message"),
        createStubTool("image_generate"),
      ],
      policy,
    );

    expect(tools.map((tool) => tool.name)).toEqual(["message", "image_generate"]);
  });

  it("does not apply to a non-group session on the same agent", () => {
    installPluginWithBaseline(() => ({ deny: [...BASELINE_DENY] }));

    // The owner's 1:1 session is not a group, so the group baseline must not
    // reach it — that would take the operator's own tools away.
    expect(
      resolveGroupToolPolicy({
        config: { channels: { whatsapp: {} } } as OpenClawConfig,
        sessionKey: "agent:main:main",
        messageProvider: "whatsapp",
      }),
    ).toBeUndefined();
  });

  it("leaves the surface untouched when the plugin declines to restrict", () => {
    installPluginWithBaseline(() => undefined);

    expect(
      resolveGroupToolPolicy({
        config: { channels: { whatsapp: {} } } as OpenClawConfig,
        sessionKey: SESSION_KEY,
        messageProvider: "whatsapp",
      }),
    ).toBeUndefined();
  });
});
