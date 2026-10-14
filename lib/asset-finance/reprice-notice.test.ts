import { describe, expect, it, vi } from "vitest"
import { queueRepriceNotice, type NoticeDb } from "./reprice-notice"

describe("queueRepriceNotice", () => {
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
