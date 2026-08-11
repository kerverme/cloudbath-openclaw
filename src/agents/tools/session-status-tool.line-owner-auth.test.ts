import { describe, expect, it } from "vitest";
import { createSessionStatusTool } from "./session-status-tool.js";

describe("session_status LINE owner authorization", () => {
  it("blocks a LINE non-owner before any session model mutation or resolution", async () => {
    const tool = createSessionStatusTool({ modelMutationAuthorized: false });
    await expect(
      tool.execute("non-owner-switch", {
        model: "openrouter/future-labs/nebulon-x",
      }),
    ).rejects.toThrow("Session model changes require an authorized owner.");
  });

  it("does not apply the owner gate to read-only current-model inspection", async () => {
    const tool = createSessionStatusTool({ modelMutationAuthorized: false });
    let message = "";
    try {
      await tool.execute("non-owner-read", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("authorized owner");
  });
});
