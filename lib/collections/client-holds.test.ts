import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { contactDunningHold } from "./client-holds"

const NOTICE = { id: "l2", reference: "LN-2", debtReviewNoticeAt: new Date("2026-10-15T00:00:00+02:00"), debtReviewNoticeRef: null }

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

  it("has no hold for a clean client, and never asks about entities then", async () => {
    const { db: fake, entityCount } = db({})
    expect(await contactDunningHold(fake, args)).toBeNull()
    expect(entityCount).not.toHaveBeenCalled()
  })

  // A director's s.86 notice is about their own credit, not the entity's; the first send ignores it too.
  it("does NOT hold an entity contact (an active director, trustee or signatory) for debt review", async () => {
    const { db: fake, entityCount } = db({ notice: true, actsForEntity: 1 })
    expect(await contactDunningHold(fake, args)).toBeNull()
    expect(entityCount).toHaveBeenCalledWith({
      where: { tenantId: "t1", clientId: "c1", active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } },
    })
  })

  it("still holds an entity contact for a death", async () => {
    expect(await contactDunningHold(db({ deceasedAt: new Date(), actsForEntity: 1 }).db, args)).toMatchObject({ kind: "DECEASED" })
  })
})
