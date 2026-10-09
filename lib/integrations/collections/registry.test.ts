import { describe, it, expect } from "vitest"
import {
  getCollectionProvider,
  getAvsProvider,
  registerProvider,
} from "./registry"
import { CollectionProviderError, type CollectionProvider } from "./types"

const fake = (id: string): CollectionProvider => ({
  id,
  verifyAccount: async () => ({ passed: true, checks: { accountActive: true, acceptsDebits: true, idNumberMatch: true, lastNameMatch: null, openThreeMonths: null }, raw: null }),
  createMandate: async () => ({ providerMandateRef: null, status: "PENDING_AUTH" }),
  getMandateStatus: async () => "PENDING_AUTH",
  cancelMandate: async () => {},
  collect: async () => ({ batchRef: "b", accepted: [], rejected: [] }),
  fetchResults: async () => [],
})

describe("getCollectionProvider", () => {
  it("throws NOT_CONFIGURED when collectionProvider is null", () => {
    expect(() => getCollectionProvider({ collectionProvider: null, avsProvider: null }))
      .toThrowError(CollectionProviderError)
    try {
      getCollectionProvider({ collectionProvider: null, avsProvider: null })
    } catch (e) {
      expect((e as CollectionProviderError).code).toBe("NOT_CONFIGURED")
    }
  })

  it("throws UNKNOWN_PROVIDER for an unregistered key", () => {
    try {
      getCollectionProvider({ collectionProvider: "nope", avsProvider: null })
      expect.unreachable()
    } catch (e) {
      expect((e as CollectionProviderError).code).toBe("UNKNOWN_PROVIDER")
    }
  })

  it("resolves a registered provider by key", () => {
    registerProvider(fake("fakeco"))
    expect(getCollectionProvider({ collectionProvider: "fakeco", avsProvider: null }).id).toBe("fakeco")
  })

  it("ships with netcash registered", () => {
    expect(getCollectionProvider({ collectionProvider: "netcash", avsProvider: null }).id).toBe("netcash")
  })
})

describe("getAvsProvider", () => {
  it("falls back to collectionProvider when avsProvider is null", () => {
    registerProvider(fake("railco"))
    expect(getAvsProvider({ collectionProvider: "railco", avsProvider: null }).id).toBe("railco")
  })

  it("prefers avsProvider when set", () => {
    registerProvider(fake("railco"))
    registerProvider(fake("avsco"))
    expect(getAvsProvider({ collectionProvider: "railco", avsProvider: "avsco" }).id).toBe("avsco")
  })
})
