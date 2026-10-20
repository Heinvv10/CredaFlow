import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { contactDunningHold, loanDunningHold } from "./client-holds"

const NOTICE = { id: "l2", reference: "LN-2", debtReviewNoticeAt: new Date("2026-10-15T00:00:00+02:00"), debtReviewNoticeRef: null }

// `actsForEntity` models a director's other roles; the hold must not look at them.
function db(opts: { clientId?: string | null; deceasedAt?: Date | null; notice?: boolean; actsForEntity?: number }) {
  const entityCount = vi.fn(async () => opts.actsForEntity ?? 0)
  return {
    entityCount,
    db: {
      contact: { findFirst: async () => ({ clientId: opts.clientId === undefined ? "c1" : opts.clientId }) },
      client: { findFirst: async () => ({ deceasedAt: opts.deceasedAt ?? null, loans: opts.notice ? [NOTICE] : [] }) },
      entityRelationship: { count: entityCount },
    },
  }
}
const args = { tenantId: "t1", contactId: "ct1" }

describe("contactDunningHold", () => {
  it("has no hold for a Contact with no client (a lead)", async () => {
    expect(await contactDunningHold(db({ clientId: null }).db, args)).toBeNull()
  })

  it("holds a deceased client", async () => {
    expect(await contactDunningHold(db({ deceasedAt: new Date() }).db, args)).toEqual({ kind: "DECEASED", reason: "a death is recorded for this client" })
  })

  it("holds a consumer under debt review, naming the loan", async () => {
    const hold = await contactDunningHold(db({ notice: true }).db, args)
    expect(hold?.kind).toBe("DEBT_REVIEW")
    expect(hold?.reason).toContain("under debt review")
    expect(hold?.reason).toContain("LN-2")
  })

  it("has no hold for a clean client, whatever their entity roles", async () => {
    expect(await contactDunningHold(db({ actsForEntity: 1 }).db, args)).toBeNull()
  })

  it("never consults entity roles at all", async () => {
    const { db: fake, entityCount } = db({ notice: true, actsForEntity: 1 })
    await contactDunningHold(fake, args)
    expect(entityCount).not.toHaveBeenCalled()
  })

  // Fail closed: the hold keys on the Contact's own client, not on their entity roles. A director
  // under personal debt review is held on a retry of their OWN consumer reminder. (An entity-debt
  // reminder to them may be held on retry too, the accepted trade-off until Message carries its loan.)
  it("holds a director who is under personal debt review: the entity roles are not an exemption", async () => {
    const { db: fake } = db({ notice: true, actsForEntity: 1 })
    expect(await contactDunningHold(fake, args)).toMatchObject({ kind: "DEBT_REVIEW", reason: expect.stringContaining("under debt review") })
  })

  it("holds a director's personal consumer reminder: the client has a notice on one of their own loans", async () => {
    const hold = await contactDunningHold(db({ notice: true, actsForEntity: 2 }).db, args)
    expect(hold).toMatchObject({ kind: "DEBT_REVIEW" })
    expect(hold?.reason).toContain("LN-2")
  })

  it("still holds an entity contact for a death", async () => {
    expect(await contactDunningHold(db({ deceasedAt: new Date(), actsForEntity: 1 }).db, args)).toMatchObject({ kind: "DECEASED" })
  })
})

// A loan table of two tenants. Every query is answered only for rows of the tenant it names, as Postgres would.
function loanDb(rows: Array<{ id: string; tenantId: string; status: string; held?: boolean }>) {
  const match = (where: { id: string; tenantId?: string }) => rows.filter((r) => r.id === where.id && (where.tenantId === undefined || r.tenantId === where.tenantId))
  return {
    loan: {
      findFirst: async (a: { where: { id: string; tenantId?: string } }) => match(a.where)[0] ?? null,
      count: async (a: { where: { id: string; tenantId?: string } }) => match(a.where).filter((r) => !r.held).length,
    },
  } as unknown as Parameters<typeof loanDunningHold>[0]
}
const ROWS = [
  { id: "loan_a", tenantId: "t_a", status: "ACTIVE", held: true },
  { id: "loan_a2", tenantId: "t_a", status: "COMPLETED" },
  { id: "loan_a3", tenantId: "t_a", status: "ACTIVE" },
  { id: "loan_a4", tenantId: "t_a", status: "DEFAULTED" },
]

describe("loanDunningHold", () => {
  const statuses = ["ACTIVE"] as const

  it("names a hold on the loan, and a status that is not dunned", async () => {
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "loan_a", statuses })).toMatch(/arrangement/)
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "loan_a2", statuses })).toBe("the loan is COMPLETED")
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "loan_a4", statuses })).toBe("the loan is DEFAULTED")
  })

  it("has no reason for a loan that is dunnable, for a notice a DEFAULTED one too, or for an id that is not a loan", async () => {
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "loan_a3", statuses })).toBeNull()
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "loan_a4", statuses: ["ACTIVE", "DEFAULTED"] })).toBeNull()
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_a", loanId: "nope", statuses })).toBeNull()
  })

  // A message's key names a loan id; another tenant's loan must never hold this tenant's message.
  it("looks only at the tenant's own loans: another tenant's held loan is not found, so it holds nothing", async () => {
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_b", loanId: "loan_a", statuses })).toBeNull()
    expect(await loanDunningHold(loanDb(ROWS), { tenantId: "t_b", loanId: "loan_a2", statuses })).toBeNull()
  })
})
