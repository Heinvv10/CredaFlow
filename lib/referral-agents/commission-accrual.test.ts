import { describe, it, expect, vi } from "vitest"
import { recordDisbursementCommission } from "./commission"

function makeClient(over: Record<string, unknown> = {}) {
  return {
    client: { findUnique: vi.fn().mockResolvedValue({ id: "c1", referralCodeId: "code1" }) },
    tenantConfig: { findUnique: vi.fn().mockResolvedValue({ referralCommissionBps: 200 }) },
    referralCode: {
      findFirst: vi.fn().mockResolvedValue({ id: "code1", agentId: "a1", agent: { status: "ACTIVE", commissionBps: null } }),
    },
    referralEvent: {
      findFirst: vi.fn().mockResolvedValue(null), // no prior CONVERTED event for this loan
      create: vi.fn().mockResolvedValue({ id: "e1" }),
    },
    ...over,
  }
}

describe("recordDisbursementCommission", () => {
  it("creates one PENDING CONVERTED event with computed commissionCents", async () => {
    const c = makeClient()
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    expect(c.referralEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: "CONVERTED", commissionStatus: "PENDING", commissionCents: 10_000, amountCents: 500_000,
      }),
    }))
  })

  it("no-ops when the client has no referral attribution", async () => {
    const c = makeClient({ client: { findUnique: vi.fn().mockResolvedValue({ id: "c1", referralCodeId: null }) } })
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    expect(c.referralEvent.create).not.toHaveBeenCalled()
  })

  it("no-ops when the agent/code is not active (resolve returns null)", async () => {
    const c = makeClient({ referralCode: { findFirst: vi.fn().mockResolvedValue(null) } })
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    expect(c.referralEvent.create).not.toHaveBeenCalled()
  })

  it("no-ops when the effective rate is 0", async () => {
    const c = makeClient({ tenantConfig: { findUnique: vi.fn().mockResolvedValue({ referralCommissionBps: 0 }) } })
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    expect(c.referralEvent.create).not.toHaveBeenCalled()
  })

  it("is idempotent — skips when a CONVERTED event already exists for the loan", async () => {
    const c = makeClient({ referralEvent: { findFirst: vi.fn().mockResolvedValue({ id: "prior" }), create: vi.fn() } })
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    expect(c.referralEvent.create).not.toHaveBeenCalled()
  })

  // The idempotency check matches ANY status by default, so a REVERSED row keeps
  // blocking accrual. That default is what makes a defaulted loan's clawback
  // permanent, and only the re-attribution path — which reversed the prior row
  // itself, in the same transaction — may opt out of it.
  it("counts a REVERSED prior as blocking by default", async () => {
    const c = makeClient()
    await recordDisbursementCommission(c as never, { tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000 })
    const where = (c.referralEvent.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).not.toHaveProperty("commissionStatus")
  })

  it("excludes REVERSED priors only when supersedeReversedPriors is set", async () => {
    const c = makeClient()
    await recordDisbursementCommission(c as never, {
      tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000,
      supersedeReversedPriors: true,
    })
    const where = (c.referralEvent.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.commissionStatus).toEqual({ not: "REVERSED" })
    expect(c.referralEvent.create).toHaveBeenCalled()
  })

  it("still refuses when a live prior survives the supersede filter", async () => {
    const c = makeClient({
      referralEvent: { findFirst: vi.fn().mockResolvedValue({ id: "live-prior" }), create: vi.fn() },
    })
    await recordDisbursementCommission(c as never, {
      tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 500_000,
      supersedeReversedPriors: true,
    })
    expect(c.referralEvent.create).not.toHaveBeenCalled()
  })
})
