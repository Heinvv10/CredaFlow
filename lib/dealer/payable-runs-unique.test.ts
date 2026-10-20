import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"

// A unique violation while creating a run is answered by the index it hit,
// not always as "a live run for this period"; any other one is not a run
// conflict and propagates.
const h = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: h.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))

import { createPayableRun } from "./payable-runs"

const staff = { tenantId: "tenant-1", userId: "user-1", userEmail: "staff@lender.invalid" }
const p2002 = (modelName: string, target: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName, target } })
const create = () => createPayableRun(staff, "dealer-1", { periodEnd: "2026-09-30" })

describe("createPayableRun unique violations", () => {
  it("names the period conflict", async () => {
    h.transaction.mockRejectedValueOnce(p2002("DealerPayableRun", ["tenantId", "dealerId", "periodEnd"]))
    expect(await create()).toEqual({ kind: "refused", status: 409, error: "The dealer already has a live run for this period" })
  })

  it("names a line already in another live run", async () => {
    h.transaction.mockRejectedValueOnce(p2002("DealerPayableRunLine", ["tenantId", "lineId"]))
    expect(await create()).toEqual({ kind: "refused", status: 409, error: "A commission line is already in another live run: refresh and try again" })
  })

  it("lets any other unique violation through", async () => {
    const other = p2002("AuditLog", ["id"])
    h.transaction.mockRejectedValueOnce(other)
    await expect(create()).rejects.toBe(other)
  })
})
