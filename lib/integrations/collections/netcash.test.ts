import { describe, it, expect, beforeEach, vi } from "vitest"
import { netcashCollections } from "./netcash"
import { type AvsRequest } from "./types"

const req: AvsRequest = {
  accountHolder: "T Client",
  idNumber: "9001015800086",
  bankName: "FNB",
  branchCode: "250655",
  accountNumber: "62000000000",
  accountType: "CHEQUE",
}

describe("netcashCollections.verifyAccount", () => {
  beforeEach(() => vi.unstubAllEnvs())

  it("returns all-pass in dry-run mode without any credentials", async () => {
    vi.stubEnv("NETCASH_COLLECTIONS_DRY_RUN", "true")
    const result = await netcashCollections.verifyAccount(req, {})
    expect(result.passed).toBe(true)
    expect(result.raw).toBe("dry-run")
  })

  it("throws NOT_CONFIGURED without a Risk-Reports service key", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NETCASH_COLLECTIONS_DRY_RUN", "false")
    await expect(netcashCollections.verifyAccount(req, {})).rejects.toMatchObject({
      name: "CollectionProviderError",
      code: "NOT_CONFIGURED",
    })
  })
})

describe("unimplemented methods", () => {
  it.each(["createMandate", "collect", "fetchResults", "getMandateStatus", "cancelMandate"] as const)(
    "%s throws NOT_IMPLEMENTED",
    async (method) => {
      const call =
        method === "createMandate"
          ? netcashCollections.createMandate({} as never, {})
          : method === "collect"
            ? netcashCollections.collect([], {})
            : method === "fetchResults"
              ? netcashCollections.fetchResults({ from: new Date(), to: new Date() }, {})
              : method === "getMandateStatus"
                ? netcashCollections.getMandateStatus("x", {})
                : netcashCollections.cancelMandate("x", {})
      await expect(call).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" })
    }
  )
})
