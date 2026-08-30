import type { PrevisTimeRangeEdit } from "./previs-document.js";
import { approvePrevis, preparePrevis, type PrevisPrepareInput } from "./previs-prepare.js";
import type { PrevisArtifactSink, PrevisEngine, PrevisStore } from "./previs-store.js";
import type { PrevisAccessClaim, PrevisVersion } from "./previs-types.js";

/**
 * The production previs composition.
 *
 * This is the seam Phase 2B's LINE routing will call. It exists so the engine
 * and the private-R2 sink are bound ONCE at service start, rather than every
 * caller re-deciding which engine a previs was rendered with. Deliberately not
 * registered as a model-facing tool yet: the previs layer stays deterministic
 * and independently testable until LINE routing lands.
 */
export class CloudbathPrevisService {
  constructor(
    private readonly store: PrevisStore,
    private readonly publicAssetBaseUrl: string,
    private readonly engine: PrevisEngine,
    private readonly artifacts: PrevisArtifactSink,
  ) {}

  /** Creates v1 of a previs, rendering and storing its artifact. */
  async prepare(input: PrevisPrepareInput) {
    return await preparePrevis({
      store: this.store,
      input,
      publicAssetBaseUrl: this.publicAssetBaseUrl,
      engine: this.engine,
      artifacts: this.artifacts,
    });
  }

  /** Appends an edited version. v1 stays retrievable; the head moves forward. */
  async edit(params: {
    previsProjectId: string;
    claim: PrevisAccessClaim;
    edit: PrevisTimeRangeEdit;
    baseVersionNumber?: number;
  }): Promise<PrevisVersion> {
    return await this.store.appendEdit({
      ...params,
      engine: this.engine,
      artifacts: this.artifacts,
    });
  }

  /** Freezes one version. Calls no provider and generates nothing. */
  async approve(params: {
    previsProjectId: string;
    claim: PrevisAccessClaim;
    versionNumber?: number;
  }): Promise<PrevisVersion> {
    return await approvePrevis({ store: this.store, ...params });
  }
}
