export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  resolveDelayMs?: (error: unknown, defaultDelayMs: number) => number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (delayMs: number) => Promise<void>;
};

const defaultSleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
};

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !options.isRetryable(error)) {
        throw error;
      }
      const exponential = options.baseDelayMs * 2 ** (attempt - 1);
      const defaultDelayMs = Math.min(options.maxDelayMs, exponential);
      const resolvedDelayMs = options.resolveDelayMs?.(error, defaultDelayMs) ?? defaultDelayMs;
      const delayMs = Math.min(options.maxDelayMs, Math.max(0, resolvedDelayMs));
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 409 || status === 425 || status === 429 || (status ?? 0) >= 500
  );
}

export function retryableAwsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (isRetryableStatus(record.$metadata?.httpStatusCode)) {
    return true;
  }
  return [
    "AbortError",
    "ECONNRESET",
    "ETIMEDOUT",
    "NetworkingError",
    "RequestTimeout",
    "SlowDown",
    "Throttling",
    "ThrottlingException",
  ].includes(record.name ?? "");
}
