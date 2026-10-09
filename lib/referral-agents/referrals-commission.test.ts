import { describe, it, expect, vi } from "vitest"
import { recordReferralEvent } from "./referrals"

describe("recordReferralEvent commissionCents", () => {
  it("passes commissionCents through to create()", async () => {
    const create = vi.fn().mockResolvedValue({ id: "e1" })
    const client = { referralEvent: { create } }
    await recordReferralEvent(client, {
      tenantId: "t1", eventType: "CONVERTED", commissionStatus: "PENDING", commissionCents: 12345,
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commissionCents: 12345, commissionStatus: "PENDING" }),
    }))
  })
  it("defaults commissionCents to null when omitted", async () => {
    const create = vi.fn().mockResolvedValue({ id: "e2" })
    await recordReferralEvent({ referralEvent: { create } }, { tenantId: "t1", eventType: "CLICK" })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commissionCents: null }),
    }))
  })
})
