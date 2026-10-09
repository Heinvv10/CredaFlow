import { describe, it, expect, vi } from "vitest"
import { resolveReferralCodeById } from "./referrals"

// The client Edit form's referral picker trusts this resolver to be the real
// gate — the browser-side filter is advisory. These tests assert the WHERE it
// actually sends, since a dropped predicate here is a cross-tenant or
// retired-code assignment, not a cosmetic bug.
function makeClient(result: unknown = { id: "code-1" }) {
  const findFirst = vi.fn().mockResolvedValue(result)
  return { client: { referralCode: { findFirst } }, findFirst }
}

describe("resolveReferralCodeById", () => {
  it("scopes the lookup to the caller's tenant AND both ACTIVE statuses", async () => {
    const { client, findFirst } = makeClient()
    await resolveReferralCodeById(client, { tenantId: "tenant-a", id: "code-1" })

    const where = findFirst.mock.calls[0][0].where
    expect(where.tenantId).toBe("tenant-a")
    expect(where.id).toBe("code-1")
    expect(where.status).toBe("ACTIVE")
    expect(where.agent).toEqual({ status: "ACTIVE" })
  })

  it("does not query at all for a null/empty id", async () => {
    const { client, findFirst } = makeClient()
    expect(await resolveReferralCodeById(client, { tenantId: "t", id: null })).toBeNull()
    expect(await resolveReferralCodeById(client, { tenantId: "t", id: "" })).toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("returns null when nothing matches (retired code / other tenant)", async () => {
    const { client } = makeClient(null)
    expect(await resolveReferralCodeById(client, { tenantId: "t", id: "gone" })).toBeNull()
  })
})
