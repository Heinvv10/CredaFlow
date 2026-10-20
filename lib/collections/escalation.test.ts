import { describe, it, expect, vi, beforeEach } from "vitest"

const tenantFindFirstMock = vi.fn()
const loanFindManyMock = vi.fn()
const loanUpdateManyMock = vi.fn()
const loanNoteFindFirstMock = vi.fn()
const loanNoteCreateMock = vi.fn()
const triggerNotificationMock = vi.fn()
const reverseReferralCommissionMock = vi.fn()
const chargesOutstandingAtMock = vi.fn()
const isLoanHeldMock = vi.fn()
const debtReviewReasonMock = vi.fn()
const ensureDpdCurrentMock = vi.fn()
const reserveOnceMock = vi.fn()
const releaseReservationMock = vi.fn()
vi.mock("@/lib/ops/send-reservation", () => ({
  reserveOnce: (...a: unknown[]) => reserveOnceMock(...a),
  releaseReservation: (...a: unknown[]) => releaseReservationMock(...a),
}))
vi.mock("@/lib/loan/dpd-update", () => ({ ensureDpdCurrent: (...a: unknown[]) => ensureDpdCurrentMock(...a) }))
vi.mock("@/lib/collections/client-holds", () => ({
  isLoanHeld: (...a: unknown[]) => isLoanHeldMock(...a),
  section129DebtReviewReason: (...a: unknown[]) => debtReviewReasonMock(...a),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: async (a: unknown) => { const t = await tenantFindFirstMock(a); return Array.isArray(t) ? t : t ? [t] : [] } },
    loan: {
      findMany: (a: unknown) => loanFindManyMock(a),
      updateMany: (a: unknown) => loanUpdateManyMock(a),
    },
    loanNote: {
      findFirst: (a: unknown) => loanNoteFindFirstMock(a),
      create: (a: unknown) => loanNoteCreateMock(a),
    },
  },
}))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (a: unknown) => triggerNotificationMock(a),
}))
vi.mock("@/lib/referral-agents/commission", () => ({
  reverseReferralCommissionForLoan: (...args: unknown[]) => reverseReferralCommissionMock(...args),
}))

vi.mock("@/lib/loan/charges-replay", () => ({
  chargesOutstandingAt: (...a: unknown[]) => chargesOutstandingAtMock(...a),
}))

import { processEscalations } from "./escalation"

// Pre-seed loanNote existence for every rule except escalation_default so only
// the rule under test runs.
const loan60d = {
  id: "loan_1",
  reference: "L-100",
  clientId: "cl_1",
  daysInArrears: 65,
  arrearsAmount: 250_000,
  outstandingPrincipal: 500_000,
  status: "ACTIVE" as const,
  ncaRegime: "NCA" as const,
}

beforeEach(() => {
  vi.resetAllMocks()
  tenantFindFirstMock.mockResolvedValue({ id: "tenant_acme" })
  loanFindManyMock.mockResolvedValue([loan60d])
  loanNoteFindFirstMock.mockImplementation((args: { where: { type: string } }) =>
    Promise.resolve(args.where.type === "escalation_default" ? null : { id: "existing-note" }),
  )
  loanNoteCreateMock.mockResolvedValue({ id: "note_1" })
  loanUpdateManyMock.mockResolvedValue({ count: 1 })
  triggerNotificationMock.mockResolvedValue(undefined)
  reverseReferralCommissionMock.mockResolvedValue(undefined)
  chargesOutstandingAtMock.mockResolvedValue(0)
  isLoanHeldMock.mockResolvedValue(false)
  reserveOnceMock.mockResolvedValue(true)
  debtReviewReasonMock.mockResolvedValue(null)
})

describe("processEscalations", () => {
  describe("the 60-DPD notice window", () => {
    it("notifies a loan that crossed 60 days recently, up to 66 DPD", async () => {
      loanFindManyMock.mockResolvedValue([{ ...loan60d, daysInArrears: 66 }])
      await processEscalations()
      expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    })

    it("flips and notes a loan already further past 60, but sends it no notice (the first-run backlog)", async () => {
      loanFindManyMock.mockResolvedValue([{ ...loan60d, daysInArrears: 67 }])
      const r = await processEscalations()
      expect(loanUpdateManyMock).toHaveBeenCalledWith({ where: { id: "loan_1", tenantId: "tenant_acme" }, data: { status: "DEFAULTED" } })
      expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "escalation_default" }) }))
      expect(triggerNotificationMock).not.toHaveBeenCalled()
      expect(r.details.join(" ")).toContain("borrower notification skipped (past the 66 DPD notice window)")
      expect(r.errors).toBe(0)
    })
  })

  it("logs and counts a DEFAULTED notice that failed, instead of swallowing it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    triggerNotificationMock.mockRejectedValue(new Error("smtp exploded"))
    const r = await processEscalations()
    expect(r.errors).toBe(1)
    // Generic in the body; the cause (and the notice failure) is in the log only.
    expect(r.details.join(" ")).toContain("Error L-100 escalation_default: failed; see the server log")
    expect(r.details.join(" ")).not.toContain("smtp exploded")
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("DEFAULTED notice failed"), expect.objectContaining({ message: "smtp exploded" }))
    logged.mockRestore()
  })

  describe("the per-rule reservation (overlapping runs)", () => {
    it("reserves each rule per loan before it acts", async () => {
      await processEscalations()
      expect(reserveOnceMock).toHaveBeenCalledWith("tenant_acme", "escalation:loan_1:escalation_default", expect.any(Date))
    })

    it("a rule another run has already reserved is skipped: no flip, no note, no notice", async () => {
      reserveOnceMock.mockResolvedValue(false)
      const r = await processEscalations()
      expect(loanUpdateManyMock).not.toHaveBeenCalled()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
      expect(triggerNotificationMock).not.toHaveBeenCalled()
      expect(r.details.join(" ")).toContain("another run is already handling it today")
      expect(r.errors).toBe(0)
    })

    it("releases the reservation when the rule failed, so the retry can run it", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      triggerNotificationMock.mockRejectedValue(new Error("smtp"))
      await processEscalations()
      // Against the day it was taken: the very instant it was reserved at.
      expect(releaseReservationMock).toHaveBeenCalledWith("escalation:loan_1:escalation_default", reserveOnceMock.mock.calls[0][2])
    })

    it("keeps the reservation of a rule that succeeded", async () => {
      await processEscalations()
      expect(releaseReservationMock).not.toHaveBeenCalled()
    })
  })

  describe("several tenants", () => {
    const tenants = [{ id: "tenant_a", name: "A" }, { id: "tenant_b", name: "B" }]

    it("makes sure DPD is current for each tenant before it reads the loans", async () => {
      tenantFindFirstMock.mockResolvedValue(tenants)
      await processEscalations()
      expect(ensureDpdCurrentMock.mock.calls.map((c) => c[0])).toEqual(["tenant_a", "tenant_b"])
    })

    it("reports a tenant that threw, names it without the cause, and still runs the next", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      tenantFindFirstMock.mockResolvedValue(tenants)
      loanFindManyMock.mockImplementation(async (a: { where: { tenantId: string } }) => {
        if (a.where.tenantId === "tenant_a") throw new Error("connection string postgres://secret")
        return [loan60d]
      })
      const r = await processEscalations()
      expect(r).toMatchObject({ tenants: 2, failedTenants: 1, errors: 1, processed: 1 })
      expect(r.details.join(" ")).toContain("Tenant A (tenant_a) failed")
      expect(r.details.join(" ")).not.toContain("secret")
      expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "tenant_b" }) }))
    })

    it("a tenant whose DPD refresh failed is not escalated on stale figures", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      ensureDpdCurrentMock.mockRejectedValueOnce(new Error("dpd failed"))
      tenantFindFirstMock.mockResolvedValue(tenants)
      const r = await processEscalations()
      expect(r.failedTenants).toBe(1)
      expect(loanFindManyMock).toHaveBeenCalledTimes(1)
    })
  })

  // F1: the DEFAULTED flip is business logic; the borrower notification is not sent to a held loan.
  it("a held loan is still flipped to DEFAULTED and noted, but the borrower is not notified, and the skip is reported", async () => {
    isLoanHeldMock.mockResolvedValue(true)

    const r = await processEscalations()

    expect(isLoanHeldMock).toHaveBeenCalledWith({ tenantId: "tenant_acme", loanId: "loan_1" })
    expect(loanUpdateManyMock).toHaveBeenCalledWith({ where: { id: "loan_1", tenantId: "tenant_acme" }, data: { status: "DEFAULTED" } })
    expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "escalation_default" }) }))
    expect(triggerNotificationMock).not.toHaveBeenCalled()
    expect(r.processed).toBe(1)
    expect(r.details.join(" ")).toContain("borrower notification skipped (dunning hold)")
  })

  it("the 60-day DEFAULTED rule triggers loan_overdue with data.amount = loan.arrearsAmount (WA vars fix)", async () => {
    const r = await processEscalations()

    expect(r.processed).toBe(1)
    expect(triggerNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "loan_overdue",
        loanId: "loan_1",
        clientId: "cl_1",
        data: expect.objectContaining({ daysOverdue: 65, amount: 250_000, escalation: "defaulted" }),
      }),
    )
  })
})

describe("processEscalations — default charges", () => {
  it("the DEFAULTED notice quotes arrears + default charges outstanding", async () => {
    chargesOutstandingAtMock.mockResolvedValue(41_000)

    await processEscalations()

    expect(chargesOutstandingAtMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant_acme", loanId: "loan_1" },
      expect.any(Date),
    )
    expect(triggerNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "loan_overdue",
        data: expect.objectContaining({ amount: 291_000 }),
      }),
    )
  })
})

describe("processEscalations — Section 129 legal review", () => {
  const loan90d = {
    id: "loan_2",
    reference: "L-200",
    clientId: "cl_2",
    daysInArrears: 90,
    arrearsAmount: 150_000,
    outstandingPrincipal: 400_000,
    status: "ACTIVE" as const,
    ncaRegime: "NCA" as const,
  }

  beforeEach(() => {
    loanFindManyMock.mockResolvedValue([loan90d])
    loanNoteFindFirstMock.mockImplementation((args: { where: { type: string } }) =>
      Promise.resolve(args.where.type === "escalation_legal" ? null : { id: "existing-note" }),
    )
  })

  it("creates a manual legal-review flag at 90 DPD without claiming a notice was sent", async () => {
    const r = await processEscalations()

    expect(r.processed).toBe(1)
    expect(loanNoteCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "escalation_legal",
          note: expect.stringContaining("no notice was auto-sent"),
        }),
      }),
    )
    expect(r.details).toEqual([
      expect.stringContaining("flagged for Section 129 legal review at 90 DPD; no notice auto-sent"),
    ])
  })

  it("does not flag Section 129 legal review for a client under debt review, writes no note, and says why", async () => {
    debtReviewReasonMock.mockResolvedValue("the client is under debt review (NCA s.86 notice received 15 Oct 2026, recorded on loan LN-2)")

    const r = await processEscalations()

    expect(debtReviewReasonMock).toHaveBeenCalledWith(expect.anything(), { tenantId: "tenant_acme", clientId: "cl_2" })
    expect(loanNoteCreateMock).not.toHaveBeenCalled()
    expect(r.errors).toBe(0)
    expect(r.details.join(" ")).toContain("legal review not flagged at 90 DPD: the client is under debt review")
  })

  it("does not create the legal-review flag below 90 DPD", async () => {
    loanFindManyMock.mockResolvedValue([{ ...loan90d, daysInArrears: 89 }])

    await processEscalations()

    expect(loanNoteCreateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "escalation_legal" }) }),
    )
  })

  it("fetches only accounts with positive principal and arrears", async () => {
    await processEscalations()

    expect(loanFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        arrearsAmount: { gt: 0 },
        outstandingPrincipal: { gt: 0 },
      }),
    }))
  })
})

describe("processEscalations — the regime decides Section 129; the borrower type decides who is messaged", () => {
  // An asset-finance loan: no Client, 95 DPD, no escalation note yet.
  const entityLoan = (ncaRegime: "NCA" | "NON_NCA") => ({
    id: `loan_e_${ncaRegime}`,
    reference: `L-E-${ncaRegime}`,
    clientId: null,
    daysInArrears: 95,
    arrearsAmount: 150_000,
    outstandingPrincipal: 400_000,
    status: "ACTIVE" as const,
    ncaRegime,
  })

  beforeEach(() => {
    loanNoteFindFirstMock.mockResolvedValue(null)
  })

  const createdNoteTypes = () =>
    loanNoteCreateMock.mock.calls.map(([args]) => (args as { data: { type: string } }).data.type)

  it("a NON_NCA entity loan is escalated and defaulted, never flagged for Section 129, with no error", async () => {
    loanFindManyMock.mockResolvedValue([entityLoan("NON_NCA")])

    const r = await processEscalations()

    expect(createdNoteTypes()).toEqual(["escalation_soft", "escalation_default"])
    expect(loanUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "loan_e_NON_NCA", tenantId: "tenant_acme" }, data: { status: "DEFAULTED" },
    })
    expect(r).toMatchObject({ processed: 2, errors: 0 })
  })

  it("an NCA entity loan is flagged for Section 129 legal review like any NCA loan", async () => {
    loanFindManyMock.mockResolvedValue([entityLoan("NCA")])

    const r = await processEscalations()

    expect(createdNoteTypes()).toEqual(["escalation_soft", "escalation_default", "escalation_legal"])
    expect(r).toMatchObject({ processed: 3, errors: 0 })
  })

  it("a defaulted entity loan's notice is raised by loan, with no clientId: triggerNotification routes it to the entity's contacts", async () => {
    // 62 DPD: inside the notice window.
    loanFindManyMock.mockResolvedValue([{ ...entityLoan("NON_NCA"), daysInArrears: 62 }])

    await processEscalations()

    expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    const [opts] = triggerNotificationMock.mock.calls[0] as [Record<string, unknown>]
    expect(opts).toMatchObject({ event: "loan_overdue", loanId: "loan_e_NON_NCA" })
    expect(opts).not.toHaveProperty("clientId")
  })

  it("a consumer loan is still messaged when it defaults", async () => {
    loanFindManyMock.mockResolvedValue([{ ...entityLoan("NCA"), id: "loan_c", clientId: "cl_c", daysInArrears: 62 }])

    await processEscalations()

    expect(triggerNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ loanId: "loan_c", clientId: "cl_c" }))
  })
})
