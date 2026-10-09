import { describe, expect, it, vi } from "vitest"
import {
  lockCurrentStatutoryProviderIdentity,
  statutoryProviderIdentityFromTenant,
} from "./statutory-provider-identity.server"

const LEGAL = "Acme Lending (Pty) Ltd"
const EXPECTED = { tenantName: LEGAL, configuredNcrNumber: "NCRCP99999", statutoryNcrNumber: "NCRCP99999" }

describe("statutory provider identity locking", () => {
  it("captures the tenant's configured legal name and NCR number used for rendering", () => {
    expect(statutoryProviderIdentityFromTenant({
      config: { legalName: LEGAL, ncrNumber: "NCRCP99999" },
    })).toEqual(EXPECTED)
  })

  it("fails closed without tenant configuration", () => {
    expect(statutoryProviderIdentityFromTenant({ config: null })).toBeNull()
  })

  // Phase 2 (D2): the configured value IS what prints, so it must be valid.
  // There is no verified constant to fall back to any more.
  it.each([null, "", "NCR99999", "NCRCP", "NCRCP 99999"])(
    "fails closed when the configured NCR number is %j",
    (ncrNumber) => {
      expect(statutoryProviderIdentityFromTenant({ config: { legalName: LEGAL, ncrNumber } })).toBeNull()
    },
  )

  // The provider name on NCA documents is the validated legal name, never a
  // blank or the tenant's display label.
  it.each([null, "", " ", "A"])("fails closed when the configured legal name is %j", (legalName) => {
    expect(statutoryProviderIdentityFromTenant({ config: { legalName, ncrNumber: "NCRCP99999" } })).toBeNull()
  })

  it("locks and compares both legal-name and NCR configuration", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ legalName: LEGAL, configuredNcrNumber: "NCRCP99999" }])
    await expect(lockCurrentStatutoryProviderIdentity({ $queryRaw: queryRaw }, "tenant-1", EXPECTED)).resolves.toBe(true)
    expect(queryRaw.mock.calls[0][0].strings.join(" ")).toContain("FOR SHARE OF tenant, config")

    queryRaw.mockResolvedValue([{ legalName: "Changed Credit Provider (Pty) Ltd", configuredNcrNumber: "NCRCP99999" }])
    await expect(lockCurrentStatutoryProviderIdentity({ $queryRaw: queryRaw }, "tenant-1", EXPECTED)).resolves.toBe(false)
  })

  it("does not lock an identity whose current NCR number became invalid", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ legalName: LEGAL, configuredNcrNumber: null }])
    await expect(lockCurrentStatutoryProviderIdentity({ $queryRaw: queryRaw }, "tenant-1", EXPECTED)).resolves.toBe(false)
  })
})
