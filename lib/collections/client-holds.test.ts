import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { contactDunningHold } from "./client-holds"

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
