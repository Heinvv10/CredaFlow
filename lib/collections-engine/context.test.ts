import { describe, expect, it } from "vitest"
import { CollectionProviderError } from "@/lib/integrations/collections/types"
import { definitelyNotSent, errorSummary, redact } from "./context"

describe("definitelyNotSent", () => {
  it("is true only for errors that prove nothing reached the provider", () => {
    for (const code of ["NOT_CONFIGURED", "NOT_IMPLEMENTED", "UNKNOWN_PROVIDER"] as const) {
      expect(definitelyNotSent(new CollectionProviderError(code, "x"))).toBe(true)
    }
    expect(definitelyNotSent(new CollectionProviderError("PROVIDER_ERROR", "timeout"))).toBe(false)
    expect(definitelyNotSent(new TypeError("fetch failed"))).toBe(false)
    expect(definitelyNotSent("NOT_CONFIGURED")).toBe(false)
  })
})

describe("redact / errorSummary", () => {
  it("masks digit runs of six or more (account, ID numbers) and keeps short numbers", () => {
    expect(redact("account 62000000001, id 9001015800086, code 51, branch 25065")).toBe(
      "account [redacted], id [redacted], code 51, branch 25065",
    )
  })

  it("truncates long provider messages", () => {
    const out = redact("x".repeat(1000))
    expect(out.length).toBe(300)
    expect(out.endsWith("…")).toBe(true)
  })

  it("redacts provider errors and reduces anything else to its class", () => {
    expect(errorSummary(new CollectionProviderError("PROVIDER_ERROR", "rejected account 62000000001"))).toBe(
      "PROVIDER_ERROR: rejected account [redacted]",
    )
    expect(errorSummary(new Error("row 62000000001 leaked"))).toBe("Error")
  })
})
