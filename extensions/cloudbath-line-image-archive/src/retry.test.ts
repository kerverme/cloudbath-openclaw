import { describe, expect, it, vi } from "vitest";
import { withBoundedRetry } from "./retry.js";

describe("withBoundedRetry", () => {
  it("bounds attempts and caps provider-requested delays", async () => {
    const operation = vi.fn(async () => {
      throw new Error("transient");
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      withBoundedRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 25,
        isRetryable: () => true,
        resolveDelayMs: () => 1_000,
        sleep,
      }),
    ).rejects.toThrow("transient");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
  });

  it("does not retry a permanent failure", async () => {
    const operation = vi.fn(async () => {
      throw new Error("permanent");
    });

    await expect(
      withBoundedRetry(operation, {
        maxAttempts: 4,
        baseDelayMs: 10,
        maxDelayMs: 20,
        isRetryable: () => false,
      }),
    ).rejects.toThrow("permanent");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
