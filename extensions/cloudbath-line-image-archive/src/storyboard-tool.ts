import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Value } from "typebox/value";
import type { CloudbathConversationRouter } from "./conversation-router.js";
import type { CloudbathStoryboardLineRouter } from "./storyboard-line-router.js";
import { storyboardToolSchema as schema } from "./storyboard-tool-schema.js";

export const STORYBOARD_TOOL_NAME = "cloudbath_storyboard";

/** The agent plans with its full multimodal context; the tool owns state and rendering. */
export function createStoryboardTool(
  context: OpenClawPluginToolContext,
  router: CloudbathStoryboardLineRouter | undefined,
  conversation?: Pick<CloudbathConversationRouter, "observeHandledTurn">,
) {
  const conversationId = context.nativeChannelId ?? context.deliveryContext?.to;
  if (
    !router ||
    context.messageChannel !== "line" ||
    context.senderIsOwner !== true ||
    !context.requesterSenderId ||
    !context.agentAccountId ||
    !conversationId
  ) {
    return null;
  }
  return {
    name: STORYBOARD_TOOL_NAME,
    label: "Visual Storyboard",
    description: [
      "Create, revise and render a visual storyboard: ordered story panels combined into a contact sheet, not a video or a single illustration.",
      "Use the conversation and attached/generated images to understand the story, characters, layout and style. Read first to discover the active/latest saved storyboard.",
      "If a storyboard exists and the owner asks for its images, render it directly. If the story exists only in chat, save ALL its scenes first; otherwise author a coherent sequence from the user's brief. Do not ask for video duration, first frame, video confirmation or Character Library.",
      "save takes the complete ordered panels, including framing, action, captions and dialogue. Preserve requested scene count and continuity; never pad with duplicate panels. For edits pass baseVersionNumber from read; use newStoryboard only for an explicitly new story.",
      "Preserve existing shot order and metadata unless asked to change it. Optional camera, environmentNote, soundDesign and dialogue retain their previous values at that panel position when omitted; supply updated values when changing or reordering shots.",
      "Use characterIds from read for frozen library cast, otherwise []. Fictional/text-described characters belong in the brief/actions and need no library.",
      "Reference image paths/URLs must come from this conversation. Label character/outfit references identity, layout/art references style; a layout reference must not recast the story. Omit references on edits to preserve the saved references.",
      "After save call render when images were requested (including a visual/comic storyboard). render generates every saved panel and delivers the contact sheet to LINE; report only the returned result. Image generation may be billable, but this tool cannot prepare or generate video.",
    ].join(" "),
    parameters: schema,
    execute: async (_toolCallId: string, input: unknown) => {
      if (!Value.Check(schema, input)) {
        throw new Error("Invalid storyboard tool input");
      }
      // This plugin does not own a sandbox bridge. Never load host references
      // on behalf of a sandboxed or workspace-confined agent.
      if (input.references?.length && (context.sandboxed || context.fsPolicy?.workspaceOnly)) {
        throw new Error("Storyboard reference imports require an unconfined media-capable session");
      }
      const event = { content: "", senderId: context.requesterSenderId, senderIsOwner: true };
      const dispatchContext = {
        channelId: "line",
        accountId: context.agentAccountId,
        conversationId,
        sessionKey: context.sessionKey,
      };
      const result = await router.handleAgentTool(input, event, dispatchContext);
      if (input.action !== "read") {
        await conversation?.observeHandledTurn(event, dispatchContext);
      }
      return jsonResult(result);
    },
  };
}
