import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { scheduleFindUnique, scheduleUpdate, noteCreate, configFindUnique, audit } = vi.hoisted(() => ({
  audit: vi.fn(),
  scheduleFindUnique: vi.fn(),
  scheduleUpdate: vi.fn(),
  noteCreate: vi.fn(),
  configFindUnique: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: "admin-1", email: "admin@test.invalid", name: "Admin" },
  })),
}))
vi.mock("@/lib/audit", () => ({ logAudit: audit }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await handler({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    repaymentSchedule: { findUnique: scheduleFindUnique, update: scheduleUpdate },
    loanNote: { create: noteCreate },
    tenantConfig: { findUnique: configFindUnique },
  },
}))

import { PATCH } from "./route"

const call = (action: string) => PATCH(
  new NextRequest("http://localhost/api/loans/loan-1/schedule/row-1", {
    method: "PATCH",
    body: JSON.stringify({ action }),
  }),
  { params: Promise.resolve({ id: "loan-1", scheduleId: "row-1" }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  scheduleFindUnique.mockResolvedValue({ id: "row-1", loanId: "loan-1", installmentNo: 2, totalDue: 216_900, totalPaid: 0, status: "PENDING" })
  scheduleUpdate.mockResolvedValue({ id: "row-1" })
  noteCreate.mockResolvedValue({})
})

describe("PATCH schedule entry", () => {
  // An instalment's totalPaid is derived from the loan's receipts; no admin
  // action may set it, with default charges on or off.
  it.each([
    { defaultChargesEnabled: true, defaultChargesStartedAt: new Date() },
    { defaultChargesEnabled: false, defaultChargesStartedAt: null },
  ])("refuses mark_paid (charges enabled: $defaultChargesEnabled)", async (config) => {
    configFindUnique.mockResolvedValue(config)
    const response = await call("mark_paid")
    expect(response.status).toBe(409)
    expect(scheduleUpdate).not.toHaveBeenCalled()
  })

  it("flags an instalment as missed without touching money, and audits it", async () => {
    expect((await call("flag_missed")).status).toBe(200)
    expect(scheduleUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "OVERDUE" } }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", userId: "admin-1", action: "SCHEDULE_INSTALMENT_FLAGGED_MISSED",
      entity: "RepaymentSchedule", entityId: "row-1",
      oldValue: { status: "PENDING" }, newValue: { status: "OVERDUE", loanId: "loan-1", installmentNo: 2 },
    }))
    expect(noteCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ note: expect.stringContaining("instalment #2:") }),
    }))
  })

  it.each(["OVERDUE", "PAID", "WRITTEN_OFF"])("refuses to flag a %s instalment as missed", async (status) => {
    scheduleFindUnique.mockResolvedValue({ id: "row-1", loanId: "loan-1", installmentNo: 2, totalDue: 216_900, totalPaid: 216_900, status })
    expect((await call("flag_missed")).status).toBe(409)
    expect(scheduleUpdate).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it.each([
    [0, "PENDING"],
    [100_000, "PARTIAL"],
    [216_900, "PAID"],
  ])("reverts an overdue flag to what %i cents paid says (%s), leaving totalPaid alone", async (totalPaid, status) => {
    scheduleFindUnique.mockResolvedValue({ id: "row-1", loanId: "loan-1", installmentNo: 2, totalDue: 216_900, totalPaid, status: "OVERDUE" })
    expect((await call("revert")).status).toBe(200)
    expect(scheduleUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status } }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "SCHEDULE_INSTALMENT_FLAG_REVERTED", oldValue: { status: "OVERDUE" },
    }))
  })

  it("refuses to revert anything but an overdue flag", async () => {
    scheduleFindUnique.mockResolvedValue({ id: "row-1", loanId: "loan-1", totalDue: 216_900, totalPaid: 216_900, status: "PAID" })
    expect((await call("revert")).status).toBe(409)
    expect(scheduleUpdate).not.toHaveBeenCalled()
  })
})
