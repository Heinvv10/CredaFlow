import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assertSmileIdentityRuntimeSafety,
  verifyBiometric,
} from "./smileidentity"

const request = {
  selfieBase64: "synthetic-image",
  idNumber: "9001015800086",
  firstName: "Synthetic",
  lastName: "Applicant",
  dateOfBirth: "1990-01-01",
  partnerUserId: "synthetic-client",
}

afterEach(() => vi.unstubAllEnvs())

describe("Smile Identity simulation boundary", () => {
  it("fails production startup when SMILE_DRY_RUN is enabled", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_IDENTITY_ENV", "production")
    vi.stubEnv("SMILE_DRY_RUN", "true")

    expect(() => assertSmileIdentityRuntimeSafety()).toThrow(
      "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
    )
  })

  it("fails closed inside biometric verification even if startup validation was bypassed", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_IDENTITY_ENV", "production")
    vi.stubEnv("SMILE_DRY_RUN", "true")

    await expect(verifyBiometric(request)).rejects.toThrow(
      "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
    )
  })

  it("fails closed on a deployed build when SMILE_IDENTITY_ENV is missing entirely", () => {
    // The scenario that matters most: a go-live deploy that forgets to set
    // SMILE_IDENTITY_ENV must still be caught, not silently treated as safe.
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_DRY_RUN", "true")

    expect(() => assertSmileIdentityRuntimeSafety()).toThrow(
      "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
    )
  })

  it("does not fail startup for a staging deploy (NODE_ENV=production, SMILE_IDENTITY_ENV=test)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_IDENTITY_ENV", "test")
    vi.stubEnv("SMILE_DRY_RUN", "true")

    expect(() => assertSmileIdentityRuntimeSafety()).not.toThrow()
  })

  it("marks every non-production dry-run result as synthetic evidence", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("SMILE_DRY_RUN", "true")

    await expect(verifyBiometric(request)).resolves.toMatchObject({
      ok: true,
      verified: true,
      simulated: true,
    })
  })
})
