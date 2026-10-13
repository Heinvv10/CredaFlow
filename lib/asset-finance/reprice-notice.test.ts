import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { queueRepriceNotice, type NoticeDb } from "./reprice-notice"

const notice = {
  tenantId: "t1", loanId: "loan-1", loanReference: "AF-1", entityId: "ent-1",
  effectiveDate: "2026-11-01", firstChangedPaymentDate: "2026-12-01",
  oldInstalmentCents: 1_000_000, newInstalmentCents: 1_050_000,
}

function db(rows: Array<{ client: { id: string } }>) {
  const relFindMany = vi.fn(async () => rows.map((r) => ({ client: { ...r.client, firstName: "TEST", lastName: "X", email: "x@client.invalid", whatsapp: null } })))
  const notifications = vi.fn()
  const handle = {
    entityRelationship: { findMany: relFindMany },
    user: { findMany: vi.fn(async () => [{ id: "admin-1" }]) },
    notification: { createMany: notifications },
  } as unknown as NoticeDb
  return { handle, relFindMany, notifications }
}

describe("queueRepriceNotice recipients", () => {
  it("are the entity's servicing contacts: active acting roles, no recorded death, once each", async () => {
    const { handle, relFindMany } = db([{ client: { id: "c-1" } }, { client: { id: "c-1" } }, { client: { id: "c-2" } }])
    expect(await queueRepriceNotice(handle, notice)).toEqual(["c-1", "c-2"])
    expect(relFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: "t1", entityId: "ent-1", active: true,
        role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] },
        client: { deceasedAt: null },
      },
    }))
  })

  it("has none for a loan without an entity, and still alerts the loan admins", async () => {
    const { handle, relFindMany, notifications } = db([])
    expect(await queueRepriceNotice(handle, { ...notice, entityId: null })).toEqual([])
    expect(relFindMany).not.toHaveBeenCalled()
    expect(notifications).toHaveBeenCalledWith({ data: [expect.objectContaining({ userId: "admin-1", type: "LOAN_REPRICED" })] })
  })

  it("distinguishes the rate effective date from the first changed payment", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }))
    const db = {
      entityRelationship: { findMany: vi.fn(async () => [{ clientId: "client-1" }]) },
      user: { findMany: vi.fn(async () => [{ id: "admin-1" }]) },
      notification: { createMany },
    } as unknown as NoticeDb

    await queueRepriceNotice(db, {
      tenantId: "tenant-1",
      loanId: "loan-1",
      loanReference: "LN-TEST",
      entityId: "entity-1",
      effectiveDate: "2026-10-01",
      firstChangedPaymentDate: "2026-11-15",
      oldInstalmentCents: 100_000,
      newInstalmentCents: 110_000,
    })

    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      body: expect.stringContaining("rate changes from 2026-10-01. From the payment due 2026-11-15"),
    })] })
  })
})
