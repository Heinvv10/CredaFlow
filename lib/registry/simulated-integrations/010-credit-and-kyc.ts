import { defineSimulatedIntegrations } from "../define"

export default defineSimulatedIntegrations({
  experian: {
    /** Experian's own sandbox signal. `UAT` is the non-production estate. */
    sandboxEnvVar: "EXPERIAN_ENV",
    sandboxSafeValues: ["UAT", "uat", "test"],
  },
  smileidentity: {
    sandboxEnvVar: "SMILE_IDENTITY_ENV",
    sandboxSafeValues: ["test"],
    /**
     * Smile's guard predates this module and its exact wording is asserted by
     * `smileidentity.test.ts`. Preserved verbatim so lifting the policy here is
     * a behaviour-preserving refactor — the tests stay a real check on the
     * guard rather than being rewritten to match whatever it now says.
     */
    legacyMessage: "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
  },
  transunion: {
    /** No provider-specific sandbox signal exists; opt-in only. */
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
  /** The fixture bureau (lib/bureau/providers/simulated.ts). Every report it
   *  returns is fabricated, so it exists only where this guard permits it. */
  "simulated-bureau": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const)
