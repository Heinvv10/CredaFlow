/**
 * L5: one instruction that fails while being vetted for submission is
 * recorded as an error and does not stop the rest of the tenant's run.
 */
import { describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findMany: vi.fn(), transaction: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { collectionInstruction: { findMany: m.findMany }, $transaction: m.transaction },
}))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))

import { submitDueInstructions } from "./submit"

const stale = (id: string) => ({
  id, instructionRef: `CI-${id}`, amountCents: 1000, actionDate: new Date("2026-10-01T00:00:00Z"), trackingDays: 3,
  mandate: { providerMandateRef: "SIM-A-m", status: "ACTIVE" },
  loan: { status: "ACTIVE" },
  repaymentSchedule: { totalDue: 1000, totalPaid: 0, status: "PENDING" },
})

describe("submitDueInstructions", () => {
  it("isolates a failing instruction: the others are still handled and the failure is reported", async () => {
    m.findMany.mockResolvedValue([stale("a"), stale("b")])
    let call = 0
    m.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      call++
      if (call === 1) throw new Error("deadlock detected")
      return cb({ collectionInstruction: { updateMany: async () => ({ count: 1 }) } })
    })
    const ctx = { tenantId: "t1", now: new Date("2026-10-20T06:00:00Z"), provider: { id: "simulated" }, creds: {} } as never
    const summary = await submitDueInstructions(ctx)
    expect(summary.stale).toBe(1)
    expect(summary.errors).toEqual(["a: Error"])
    expect(summary.batches).toBe(0)
  })
})
