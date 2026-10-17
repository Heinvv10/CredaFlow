import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { logAuditStrict } from "./audit"

describe("logAuditStrict", () => {
  it("never writes settlement evidence keys a request body supplied", async () => {
    const create = vi.fn(async () => ({}))
    await logAuditStrict({
      tenantId: "t1", action: "ATTORNEY_UPDATED", entity: "Attorney", entityId: "a1",
      newValue: { name: "Synthetic Attorneys", earlyInstalmentSettlement: true, earlyDailySettlement: true, contractualRows: [] },
    }, { auditLog: { create } } as never)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ newValue: { name: "Synthetic Attorneys" } }) })
  })

  it("writes any other value as given", async () => {
    const create = vi.fn(async () => ({}))
    await logAuditStrict({ action: "X", entity: "Y", newValue: { a: 1 } }, { auditLog: { create } } as never)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ newValue: { a: 1 } }) })
  })
})
