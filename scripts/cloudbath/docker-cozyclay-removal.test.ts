import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CozyClay was the previs render engine. It is no longer part of the product,
 * but it outlived that decision inside the production image: the root
 * Dockerfile still built a `cozyclay` stage and the Railway overlay still
 * copied it in, so every deploy kept installing an AGPL package the runtime
 * had stopped constructing -- until upstream published a peer-conflicting
 * dependency and the build failed outright.
 *
 * The predecessor of this file asserted the two Dockerfiles installed CozyClay
 * IDENTICALLY, because the overlay had once been missed. That drift risk is
 * unchanged; only its direction flipped. So this file asserts the inverse
 * across BOTH files: reintroducing CozyClay into either one fails CI, rather
 * than shipping to Railway and being discovered by a broken build.
 */

const PRODUCTION_FILES = [
  "Dockerfile",
  "deploy/cloudbath/railway/Dockerfile",
  "extensions/cloudbath-line-image-archive/src/config.ts",
  "extensions/cloudbath-line-image-archive/src/types.ts",
] as const;

/**
 * Markers that can only appear in a LIVE dependency on CozyClay: a build stage,
 * an install, a filesystem root, an env contract, or the deleted adapter's
 * exports. Prose is deliberately not matched -- explaining why the engine is
 * gone is exactly the comment a future reader needs, and `previs/cozyclay`
 * remains the storage prefix of artifacts already written to R2.
 */
const LIVE_DEPENDENCY_MARKERS = [
  /\bAS\s+cozyclay\b/iu,
  /--from=cozyclay\b/iu,
  /\bcozyclay@/iu,
  /\/opt\/cozyclay\b/iu,
  /\bCLOUDBATH_COZYCLAY_(?:ROOT|VERSION)\b/u,
  /\bCOZYCLAY_VERSION\b/u,
  /\bCozyClayMcpEngine\b/u,
  /\bresolveCozyClayProvisioning\b/u,
  /\bcozyClayEngineConfig\b/u,
  /\bcozyClay(?:Root|Version)\b/u,
];

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("CozyClay stays out of the production image and runtime config", () => {
  it.each(PRODUCTION_FILES)("has no live CozyClay dependency in %s", (path) => {
    const text = read(path);
    const found = LIVE_DEPENDENCY_MARKERS.filter((marker) => marker.test(text)).map(String);
    expect(found).toEqual([]);
  });

  it("builds no cozyclay stage in either Dockerfile", () => {
    for (const path of ["Dockerfile", "deploy/cloudbath/railway/Dockerfile"]) {
      expect(read(path)).not.toMatch(/^FROM\s+\S+\s+AS\s+cozyclay\s*$/imu);
    }
  });

  it("ships no CozyClay environment contract in either Dockerfile", () => {
    for (const path of ["Dockerfile", "deploy/cloudbath/railway/Dockerfile"]) {
      expect(read(path)).not.toMatch(/\bENV\s+CLOUDBATH_COZYCLAY_/u);
    }
  });

  it("keeps the two Dockerfiles agreeing that CozyClay is absent", () => {
    // The overlay is hand-maintained. Removing the stage from one file and not
    // the other is the same class of drift that let it linger, so compare the
    // decision rather than trusting both to be edited together.
    const present = ["Dockerfile", "deploy/cloudbath/railway/Dockerfile"].map((path) =>
      /cozyclay/iu.test(read(path)),
    );
    expect(present).toEqual([false, false]);
  });
});
