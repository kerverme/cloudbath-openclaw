import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { detectCanonicalImageExtensionFromBytes } from "./r2.js";

const SCOPE_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const EXTENSION_PATTERN = /^\.(?:avif|bmp|gif|heic|jpg|png|tiff|webp)$/u;

export const UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR = path.join(
  "artifacts",
  "cloudbath-line-image-archive",
  "ugc-character-pending",
);

export type UgcCharacterMediaFailureReason =
  | "MANAGED_MEDIA_UNAVAILABLE"
  | "MEDIA_TOO_LARGE"
  | "UNSUPPORTED_IMAGE"
  | "DURABLE_COPY_FAILED"
  | "DURABLE_MEDIA_UNAVAILABLE"
  | "HASH_MISMATCH";

export class UgcCharacterMediaError extends Error {
  constructor(readonly reason: UgcCharacterMediaFailureReason) {
    super(reason);
    this.name = "UgcCharacterMediaError";
  }
}

export type CapturedCharacterMedia = Readonly<{
  durableMediaKey: string;
  bytes: Buffer;
  contentLength: number;
  sha256: string;
  extension: string;
}>;

function failure(reason: UgcCharacterMediaFailureReason): never {
  throw new UgcCharacterMediaError(reason);
}

function mediaIdFromManagedPath(sourcePath: string): string {
  if (!path.isAbsolute(sourcePath) || sourcePath.includes("\0")) {
    return failure("MANAGED_MEDIA_UNAVAILABLE");
  }
  const id = path.basename(sourcePath);
  if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    return failure("MANAGED_MEDIA_UNAVAILABLE");
  }
  return id;
}

function classifyManagedMediaError(error: unknown): UgcCharacterMediaFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("maximum") || message.includes("too large")
    ? "MEDIA_TOO_LARGE"
    : "MANAGED_MEDIA_UNAVAILABLE";
}

async function readAuthoritativeManagedMedia(
  sourcePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const id = mediaIdFromManagedPath(sourcePath);
  try {
    const media = await readMediaBuffer(id, "inbound", maxBytes);
    const sourceRealPath = await fsp.realpath(sourcePath);
    if (sourceRealPath !== media.path) {
      return failure("MANAGED_MEDIA_UNAVAILABLE");
    }
    if (media.size <= 0 || media.size !== media.buffer.byteLength) {
      return failure("MANAGED_MEDIA_UNAVAILABLE");
    }
    return media.buffer;
  } catch (error) {
    if (error instanceof UgcCharacterMediaError) {
      throw error;
    }
    return failure(classifyManagedMediaError(error));
  }
}

function validateImage(bytes: Buffer): string {
  const extension = detectCanonicalImageExtensionFromBytes(bytes);
  if (!EXTENSION_PATTERN.test(extension)) {
    return failure("UNSUPPORTED_IMAGE");
  }
  return extension;
}

function parseDurableMediaKey(key: string): {
  scopeKey: string;
  sha256: string;
  extension: string;
} {
  const parts = key.split("/");
  if (parts.length !== 2 || !SCOPE_PATTERN.test(parts[0] ?? "")) {
    return failure("DURABLE_MEDIA_UNAVAILABLE");
  }
  const filename = parts[1] ?? "";
  const extension = path.extname(filename);
  const sha256 = filename.slice(0, -extension.length);
  if (!SHA_PATTERN.test(sha256) || !EXTENSION_PATTERN.test(extension)) {
    return failure("DURABLE_MEDIA_UNAVAILABLE");
  }
  return { scopeKey: parts[0] ?? "", sha256, extension };
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollowFlag());
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      return failure(before.size > maxBytes ? "MEDIA_TOO_LARGE" : "DURABLE_MEDIA_UNAVAILABLE");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || after.size !== before.size) {
      return failure("HASH_MISMATCH");
    }
    return bytes;
  } catch (error) {
    if (error instanceof UgcCharacterMediaError) {
      throw error;
    }
    return failure("DURABLE_MEDIA_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class UgcCharacterPendingMediaStore {
  constructor(
    private readonly stateDir: string,
    private readonly maxBytes: number,
  ) {}

  private async ensureOwnedRoot(): Promise<string> {
    try {
      const stateRealPath = await fsp.realpath(this.stateDir);
      let currentRealPath = stateRealPath;
      const expectedSegments = UGC_CHARACTER_PENDING_MEDIA_RELATIVE_DIR.split(path.sep).filter(
        Boolean,
      );
      for (const [index, segment] of expectedSegments.entries()) {
        const candidatePath = path.join(currentRealPath, segment);
        await fsp.mkdir(candidatePath, { mode: 0o700 }).catch((error: unknown) => {
          if (!hasErrorCode(error, "EEXIST")) {
            throw error;
          }
        });
        const candidateStat = await fsp.lstat(candidatePath);
        if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
          return failure("DURABLE_COPY_FAILED");
        }
        const candidateRealPath = await fsp.realpath(candidatePath);
        const expectedRelativePath = path.join(...expectedSegments.slice(0, index + 1));
        if (path.relative(stateRealPath, candidateRealPath) !== expectedRelativePath) {
          return failure("DURABLE_COPY_FAILED");
        }
        currentRealPath = candidateRealPath;
      }
      return currentRealPath;
    } catch (error) {
      if (error instanceof UgcCharacterMediaError) {
        throw error;
      }
      return failure("DURABLE_COPY_FAILED");
    }
  }

  private async ensureScopeDirectory(rootRealPath: string, scopeKey: string): Promise<string> {
    try {
      const scopePath = path.join(rootRealPath, scopeKey);
      await fsp.mkdir(scopePath, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
      });
      const scopeStat = await fsp.lstat(scopePath);
      if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) {
        return failure("DURABLE_COPY_FAILED");
      }
      const scopeRealPath = await fsp.realpath(scopePath);
      if (path.relative(rootRealPath, scopeRealPath) !== scopeKey) {
        return failure("DURABLE_COPY_FAILED");
      }
      return scopeRealPath;
    } catch (error) {
      if (error instanceof UgcCharacterMediaError) {
        throw error;
      }
      return failure("DURABLE_COPY_FAILED");
    }
  }

  private async resolveDurableFilePath(params: {
    scopeKey: string;
    sha256: string;
    extension: string;
  }): Promise<string> {
    try {
      const rootRealPath = await this.ensureOwnedRoot();
      const scopePath = path.join(rootRealPath, params.scopeKey);
      const scopeStat = await fsp.lstat(scopePath);
      if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) {
        return failure("DURABLE_MEDIA_UNAVAILABLE");
      }
      const scopeRealPath = await fsp.realpath(scopePath);
      if (path.relative(rootRealPath, scopeRealPath) !== params.scopeKey) {
        return failure("DURABLE_MEDIA_UNAVAILABLE");
      }
      const expectedRelativePath = path.join(
        params.scopeKey,
        `${params.sha256}${params.extension}`,
      );
      const candidatePath = path.join(scopeRealPath, `${params.sha256}${params.extension}`);
      const candidateStat = await fsp.lstat(candidatePath);
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
        return failure("DURABLE_MEDIA_UNAVAILABLE");
      }
      const candidateRealPath = await fsp.realpath(candidatePath);
      if (path.relative(rootRealPath, candidateRealPath) !== expectedRelativePath) {
        return failure("DURABLE_MEDIA_UNAVAILABLE");
      }
      return candidateRealPath;
    } catch (error) {
      if (error instanceof UgcCharacterMediaError) {
        throw error;
      }
      return failure("DURABLE_MEDIA_UNAVAILABLE");
    }
  }

  async capture(sourcePath: string, scopeKey: string): Promise<CapturedCharacterMedia> {
    if (!SCOPE_PATTERN.test(scopeKey)) {
      return failure("DURABLE_COPY_FAILED");
    }
    const bytes = await readAuthoritativeManagedMedia(sourcePath, this.maxBytes);
    const extension = validateImage(bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const durableMediaKey = `${scopeKey}/${sha256}${extension}`;
    let destination: string;
    let temporary = "";
    let handle: fsp.FileHandle | undefined;
    try {
      const rootRealPath = await this.ensureOwnedRoot();
      const scopeRealPath = await this.ensureScopeDirectory(rootRealPath, scopeKey);
      destination = path.join(scopeRealPath, `${sha256}${extension}`);
      temporary = path.join(scopeRealPath, `.${sha256}.${crypto.randomUUID()}.tmp`);
      handle = await fsp.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(temporary, destination);
      return { durableMediaKey, bytes, contentLength: bytes.byteLength, sha256, extension };
    } catch (error) {
      if (error instanceof UgcCharacterMediaError) {
        throw error;
      }
      return failure("DURABLE_COPY_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporary) {
        await fsp.unlink(temporary).catch(() => undefined);
      }
    }
  }

  async read(params: {
    durableMediaKey: string;
    scopeKey: string;
    expectedSize: number;
    expectedSha256: string;
  }): Promise<CapturedCharacterMedia> {
    const parsed = parseDurableMediaKey(params.durableMediaKey);
    if (
      parsed.scopeKey !== params.scopeKey ||
      parsed.sha256 !== params.expectedSha256 ||
      !SHA_PATTERN.test(params.expectedSha256)
    ) {
      return failure("HASH_MISMATCH");
    }
    const filePath = await this.resolveDurableFilePath(parsed);
    const bytes = await readRegularFile(filePath, this.maxBytes);
    if (bytes.byteLength !== params.expectedSize) {
      return failure("HASH_MISMATCH");
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== params.expectedSha256) {
      return failure("HASH_MISMATCH");
    }
    const extension = validateImage(bytes);
    if (extension !== parsed.extension) {
      return failure("HASH_MISMATCH");
    }
    return {
      durableMediaKey: params.durableMediaKey,
      bytes,
      contentLength: bytes.byteLength,
      sha256,
      extension,
    };
  }

  async delete(durableMediaKey: string): Promise<void> {
    const parsed = parseDurableMediaKey(durableMediaKey);
    const filePath = await this.resolveDurableFilePath(parsed);
    await fsp.unlink(filePath).catch(() => undefined);
    await fsp.rmdir(path.dirname(filePath)).catch(() => undefined);
  }

  async sweepExpired(activeKeys: ReadonlySet<string>, expiresBefore: number): Promise<void> {
    const rootRealPath = await this.ensureOwnedRoot();
    const scopeEntries = await fsp.readdir(rootRealPath, { withFileTypes: true }).catch(() => []);
    for (const scopeEntry of scopeEntries) {
      if (!scopeEntry.isDirectory() || !SCOPE_PATTERN.test(scopeEntry.name)) {
        continue;
      }
      const scopeDir = path.join(rootRealPath, scopeEntry.name);
      const fileEntries = await fsp.readdir(scopeDir, { withFileTypes: true }).catch(() => []);
      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) {
          continue;
        }
        const durableMediaKey = `${scopeEntry.name}/${fileEntry.name}`;
        if (activeKeys.has(durableMediaKey)) {
          continue;
        }
        try {
          parseDurableMediaKey(durableMediaKey);
          const filePath = path.join(scopeDir, fileEntry.name);
          const stat = await fsp.lstat(filePath);
          if (stat.isFile() && stat.mtimeMs <= expiresBefore) {
            await fsp.unlink(filePath);
          }
        } catch {
          // Invalid or concurrently removed files are never followed or treated as active media.
        }
      }
      await fsp.rmdir(scopeDir).catch(() => undefined);
    }
  }
}
