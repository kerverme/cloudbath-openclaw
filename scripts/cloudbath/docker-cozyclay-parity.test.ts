import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COZYCLAY_PINNED_VERSION } from "../../extensions/cloudbath-line-image-archive/src/previs-cozyclay-runtime.js";

/**
 * Railway builds production from `deploy/cloudbath/railway/Dockerfile`, a
 * hand-maintained overlay of the root `Dockerfile` (its README says it
 * "preserves the upstream stages and commands"). CozyClay provisioning was
 * added to the root Dockerfile in Phase 2A but missed this overlay, so the
 * deployed image silently lacked `/opt/cozyclay` while the gateway still
 * reported healthy -- previs just logged `previs_engine_unavailable` and
 * disabled itself. This is the only thing standing between that regression
 * recurring silently and CI catching it, so it compares the two files
 * directly rather than trusting each to be edited in lockstep.
 */

const ROOT_DOCKERFILE = new URL("../../Dockerfile", import.meta.url);
const RAILWAY_DOCKERFILE = new URL("../../deploy/cloudbath/railway/Dockerfile", import.meta.url);

/** Strips full-line `#` comments so the two files' own commentary may differ. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*#/.test(line));
}

/** The `cozyclay` build stage: from its `FROM` line to the next top-level `FROM`. */
function cozyClayStage(text: string): string {
  const match = /FROM \$\{OPENCLAW_NODE_BOOKWORM_IMAGE\} AS cozyclay\n[\s\S]*?\n(?=FROM )/u.exec(
    text,
  );
  if (!match) {
    throw new Error("cozyclay build stage not found");
  }
  return codeLines(match[0]).join("\n").trim();
}

/** The lines that wire the built stage into the runtime image. */
function cozyClayRuntimeWiring(text: string): string {
  const match =
    /COPY --from=cozyclay --chown=node:node \/opt\/cozyclay \/opt\/cozyclay\nENV CLOUDBATH_COZYCLAY_ROOT=\S+ \\\n\s+CLOUDBATH_COZYCLAY_VERSION=\S+/u.exec(
      text,
    );
  if (!match) {
    throw new Error("cozyclay runtime COPY/ENV wiring not found");
  }
  return match[0];
}

describe("Railway Dockerfile stays in sync with root Dockerfile CozyClay provisioning", () => {
  const root = readFileSync(ROOT_DOCKERFILE, "utf8");
  const railway = readFileSync(RAILWAY_DOCKERFILE, "utf8");

  it("has an identical cozyclay build stage in both Dockerfiles", () => {
    expect(cozyClayStage(railway)).toBe(cozyClayStage(root));
  });

  it("has identical runtime COPY/ENV wiring in both Dockerfiles", () => {
    expect(cozyClayRuntimeWiring(railway)).toBe(cozyClayRuntimeWiring(root));
  });

  it("pins the exact version the previs runtime expects", () => {
    for (const text of [root, railway]) {
      expect(text).toContain(`ARG COZYCLAY_VERSION=${COZYCLAY_PINNED_VERSION}`);
      expect(text).toContain(`CLOUDBATH_COZYCLAY_VERSION=${COZYCLAY_PINNED_VERSION}`);
    }
  });

  it("copies /opt/cozyclay into the runtime image with the pinned root path", () => {
    for (const text of [root, railway]) {
      expect(text).toContain("COPY --from=cozyclay --chown=node:node /opt/cozyclay /opt/cozyclay");
      expect(text).toContain("ENV CLOUDBATH_COZYCLAY_ROOT=/opt/cozyclay");
    }
  });
});
