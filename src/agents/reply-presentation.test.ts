/**
 * Core asks the channel for the turn's policy and owns none of it.
 *
 * The important contracts are the negative ones: a channel that declares
 * nothing, or whose resolver throws, must leave the turn exactly as it was
 * before this seam existed rather than failing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoadedChannelPluginMock = vi.fn();

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => getLoadedChannelPluginMock(...args),
}));

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelReplyPresentation } from "./reply-presentation.js";

const CFG = { channels: { line: { replyLanguage: "th" } } } as unknown as OpenClawConfig;

const resolve = (channel: string | undefined = "line") =>
  resolveChannelReplyPresentation({
    cfg: CFG,
    channel,
    accountId: "default",
    groupId: "C1",
    requestText: "แปลคำนี้",
  });

beforeEach(() => {
  getLoadedChannelPluginMock.mockReset();
});

describe("reading a channel's reply presentation policy", () => {
  it("passes the conversation and this turn's request to the channel", () => {
    const replyPresentation = vi.fn(() => ({ expectedReplyLanguage: "th" }));
    getLoadedChannelPluginMock.mockReturnValue({ agentPrompt: { replyPresentation } });

    expect(resolve()).toEqual({ expectedReplyLanguage: "th" });
    expect(replyPresentation).toHaveBeenCalledWith({
      cfg: CFG,
      accountId: "default",
      groupId: "C1",
      groupChannel: null,
      groupSpace: null,
      senderId: null,
      requestText: "แปลคำนี้",
    });
  });

  it("returns undefined when the channel declares no policy", () => {
    getLoadedChannelPluginMock.mockReturnValue({ agentPrompt: {} });

    expect(resolve()).toBeUndefined();
  });

  it("returns undefined when the channel cannot be resolved", () => {
    getLoadedChannelPluginMock.mockImplementation(() => {
      throw new Error("not loaded");
    });

    expect(resolve()).toBeUndefined();
  });

  it("returns undefined for a surface with no loaded channel plugin", () => {
    getLoadedChannelPluginMock.mockReturnValue(undefined);

    expect(resolve(undefined)).toBeUndefined();
    expect(resolve("not-a-channel")).toBeUndefined();
  });

  it("does not fail the turn when the channel's resolver throws", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      agentPrompt: {
        replyPresentation: () => {
          throw new Error("bad config");
        },
      },
    });

    expect(resolve()).toBeUndefined();
  });
});
