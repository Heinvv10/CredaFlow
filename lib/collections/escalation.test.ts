import { describe, it, expect, vi, beforeEach } from "vitest"

const tenantFindFirstMock = vi.fn()
const loanFindManyMock = vi.fn()
const loanUpdateManyMock = vi.fn()
const loanNoteFindFirstMock = vi.fn()
const loanNoteCreateMock = vi.fn()
const triggerNotificationMock = vi.fn()
const reverseReferralCommissionMock = vi.fn()
const chargesOutstandingAtMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findFirst: (a: unknown) => tenantFindFirstMock(a) },
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
})

describe("processEscalations", () => {
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
    loanFindManyMock.mockResolvedValue([entityLoan("NON_NCA")])

    await processEscalations()

    expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    const [opts] = triggerNotificationMock.mock.calls[0] as [Record<string, unknown>]
    expect(opts).toMatchObject({ event: "loan_overdue", loanId: "loan_e_NON_NCA" })
    expect(opts).not.toHaveProperty("clientId")
  })

  it("a consumer loan is still messaged when it defaults", async () => {
    loanFindManyMock.mockResolvedValue([{ ...entityLoan("NCA"), id: "loan_c", clientId: "cl_c" }])

    await processEscalations()

    expect(triggerNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ loanId: "loan_c", clientId: "cl_c" }))
  })
})
