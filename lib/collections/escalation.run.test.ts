import { describe, it, expect, vi, beforeEach } from "vitest"
import { Prisma } from "@prisma/client"
// The nightly run around the rules (the per-rule tests are in escalation.test.ts): the 60-DPD notice
// window, the per-rule reservation, one loan's failure and several tenants. The mocks are the same.

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
    triggerNotificationMock.mockRejectedValueOnce(new Error("smtp exploded"))
    // A second loan, so this is one loan's failure and not the whole tenant's.
    loanFindManyMock.mockResolvedValue([loan60d, { ...loan60d, id: "loan_2", reference: "L-200" }])
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

  describe("one loan's failure", () => {
    // The note check and the reservation sit before the rule's own try/catch: a throw from either used to
    // end the tenant's day, so the loans after it were never escalated.
    it.each([
      ["the note check", () => loanNoteFindFirstMock.mockRejectedValueOnce(new Error("deadlock"))],
      ["the reservation", () => reserveOnceMock.mockRejectedValueOnce(new Error("connection reset"))],
    ])("a throw from %s is counted for that loan and the next loan is still escalated", async (_name, arrange) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      arrange()
      loanFindManyMock.mockResolvedValue([loan60d, { ...loan60d, id: "loan_2", reference: "L-200" }])
      const r = await processEscalations()

      expect(r.failedTenants).toBe(0)
      expect(r.errors).toBe(1)
      expect(r.details).toContainEqual(expect.stringMatching(/^Error L-100 escalation_\w+: failed; see the server log$/))
      expect(JSON.stringify(r.details)).not.toMatch(/deadlock|connection reset/)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("L-100"), expect.any(Error))
      expect(loanUpdateManyMock).toHaveBeenCalledWith({ where: { id: "loan_2", tenantId: "tenant_acme" }, data: { status: "DEFAULTED" } })
    })
  })

  describe("a fault that is not one loan's", () => {
    const loans = () => [loan60d, { ...loan60d, id: "loan_2", reference: "L-200" }]
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError("msg", { code, clientVersion: "5.22.0" })

    it.each([
      ["an initialisation error", () => new Prisma.PrismaClientInitializationError("can't reach the database", "5.22.0")],
      ["P1001", () => known("P1001")],
      ["P2024", () => known("P2024")],
    ])("%s fails the tenant at once, so the claim is retried", async (_name, error) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValueOnce(error())
      loanFindManyMock.mockResolvedValue(loans())
      const r = await processEscalations()
      expect(r).toMatchObject({ failedTenants: 1, tenants: 1 })
      expect(loanNoteFindFirstMock).toHaveBeenCalledTimes(1)
    })

    it("a unique violation (P2002) on one loan is that loan's error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValueOnce(known("P2002"))
      loanFindManyMock.mockResolvedValue(loans())
      expect(await processEscalations()).toMatchObject({ failedTenants: 0, errors: 1 })
    })

    it("every loan failing fails the tenant", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValue(new Error("systemic"))
      loanFindManyMock.mockResolvedValue(loans())
      expect((await processEscalations()).failedTenants).toBe(1)
    })

    it("a loan that only fails to be noted is not 'every loan' when another loan was escalated", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValueOnce(new Error("one"))
      loanFindManyMock.mockResolvedValue(loans())
      expect((await processEscalations()).failedTenants).toBe(0)
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
})
