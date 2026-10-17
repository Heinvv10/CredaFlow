import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { queueRepriceNotice, type NoticeDb } from "./reprice-notice"

const notice = {
  contractRateId: "rate-1", resultingRate: "0.13", totalInterestCents: 90000, monthlyInterestCents: 1200,
  tenantId: "t1", loanId: "loan-1", loanReference: "AF-1", entityId: "ent-1",
  effectiveDate: "2026-11-01", firstChangedPaymentDate: "2026-12-01",
  oldInstalmentCents: 1_000_000, newInstalmentCents: 1_050_000,
}

function db(rows: Array<{ client: { id: string } }>) {
  const relFindMany = vi.fn(async () => rows.map((r) => ({ client: { ...r.client, firstName: "TEST", lastName: "X", email: "x@client.invalid", whatsapp: null } })))
  const notifications = vi.fn()
  const handle = {
    assetFinanceRateNotice: { create: vi.fn() },
    loan: { findFirst: vi.fn(async () => null) },
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
      assetFinanceRateNotice: { create: vi.fn() },
      loan: { findFirst: vi.fn(async () => null) },
      entityRelationship: { findMany: vi.fn(async () => [{
        client: { id: "client-1", firstName: "TEST", lastName: "CLIENT", email: "test@client.invalid", whatsapp: null },
      }]) },
      user: { findMany: vi.fn(async () => [{ id: "admin-1" }]) },
      notification: { createMany },
    } as unknown as NoticeDb

    await queueRepriceNotice(db, {
      contractRateId: "rate-2", resultingRate: "0.13", totalInterestCents: 90000, monthlyInterestCents: 1200,
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

it("durably queues the written rate and instalment notice inside the repricing transaction", async () => {
  const { handle } = db([{ client: { id: "c-1" } }])
  const create = vi.fn()
  Object.assign(handle, { assetFinanceRateNotice: { create } })
  await queueRepriceNotice(handle, { ...notice, contractRateId: "rate-1", resultingRate: "0.13" })
  expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
    tenantId: "t1", loanId: "loan-1", contractRateId: "rate-1", resultingRate: "0.13",
    recipientClientIds: ["c-1"], oldInstalmentCents: 1_000_000, newInstalmentCents: 1_050_000,
  }) })
})


it("queues the natural borrower for a loan without an entity", async () => {
  const { handle } = db([])
  const create = vi.fn()
  Object.assign(handle, { loan: { findFirst: vi.fn(async () => ({ clientId: "natural-1" })) }, assetFinanceRateNotice: { create } })
  expect(await queueRepriceNotice(handle, { ...notice, entityId: null })).toEqual(["natural-1"])
  expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ recipientClientIds: ["natural-1"] }) })
})
