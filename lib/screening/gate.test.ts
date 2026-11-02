import { describe, expect, it, vi } from "vitest"
import { lockedBorrowerScreeningAllows } from "./gate"

/** No provider configured at the moment of the lock: the path that returns before any subject is read. */
const noProvider = { tenantConfig: { findUnique: vi.fn(async () => ({ screeningProvider: null })) } }
const allows = (options?: { providerRequired?: boolean }) =>
  lockedBorrowerScreeningAllows(noProvider as never, "t1", { clientId: "c1", entityId: null }, "approver", options)

describe("lockedBorrowerScreeningAllows with no provider configured under the lock", () => {
  it("refuses a key-facts approval: the provider was removed between decide's pre-check and the lock", async () => {
    expect(await allows({ providerRequired: true })).toBe(false)
  })

  it("allows an NCA approval, as it always has: the bureau is that loan's identity-risk evidence", async () => {
    expect(await allows()).toBe(true)
    expect(await allows({ providerRequired: false })).toBe(true)
  })
})
