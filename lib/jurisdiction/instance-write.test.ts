import { beforeEach, describe, expect, it, vi } from "vitest"

const { logAuditStrict } = vi.hoisted(() => ({ logAuditStrict: vi.fn() }))
vi.mock("@/lib/audit", () => ({ logAuditStrict, AuditAction: { INSTANCE_JURISDICTION_SET: "INSTANCE_JURISDICTION_SET" } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { setInstanceJurisdiction } from "./instance-write"

function fakeDb(state: { row: { jurisdiction: string; currency: string } | null; applications?: number; loans?: number }) {
  const upsert = vi.fn(async () => undefined)
  const updateMany = vi.fn(async () => ({ count: 2 }))
  const executeRaw = vi.fn(async () => 0)
  const tx = {
    instanceJurisdiction: { findUnique: async () => state.row, upsert },
    loanApplication: { count: async () => state.applications ?? 0 },
    loan: { count: async () => state.loans ?? 0 },
    tenantConfig: { updateMany },
    $executeRaw: executeRaw,
  }
  return { db: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never, upsert, updateMany, executeRaw }
}
const ask = (over: Record<string, unknown> = {}) => ({ jurisdiction: "LS", currency: "LSL", actor: "ops@host", reason: "Lesotho PostBank instance", ...over })

beforeEach(() => logAuditStrict.mockReset())

describe("setInstanceJurisdiction", () => {
  it("sets the row, moves the lenders' configs with it, and audits who and why", async () => {
    const { db, upsert, updateMany, executeRaw } = fakeDb({ row: { jurisdiction: "ZA", currency: "ZAR" } })
    expect(await setInstanceJurisdiction(db, ask())).toEqual({ ok: true, changed: true, jurisdiction: "LS", currency: "LSL" })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ jurisdiction: "LS", currency: "LSL", setBy: "ops@host" }) }))
    expect(updateMany).toHaveBeenCalledWith({ data: { jurisdiction: "LS", currency: "LSL" } })
    // The commit-time agreement check is forced inside the transaction, after the lenders moved.
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(executeRaw.mock.invocationCallOrder[0])
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "INSTANCE_JURISDICTION_SET", userEmail: "ops@host",
      oldValue: { jurisdiction: "ZA", currency: "ZAR" },
      newValue: expect.objectContaining({ jurisdiction: "LS", reason: "Lesotho PostBank instance", lendersMoved: 2 }),
    }), expect.anything())
  })

  it("is a no-op, with no audit row, when nothing changes", async () => {
    const { db, upsert } = fakeDb({ row: { jurisdiction: "LS", currency: "LSL" } })
    expect(await setInstanceJurisdiction(db, ask())).toMatchObject({ ok: true, changed: false })
    expect(upsert).not.toHaveBeenCalled()
    expect(logAuditStrict).not.toHaveBeenCalled()
  })

  it("is refused once any loan application or loan exists", async () => {
    const withApp = fakeDb({ row: { jurisdiction: "ZA", currency: "ZAR" }, applications: 1 })
    const refused = await setInstanceJurisdiction(withApp.db, ask())
    expect(refused).toMatchObject({ ok: false })
    expect((refused as { error: string }).error).toMatch(/1 loan application.*new instance/)
    expect(withApp.upsert).not.toHaveBeenCalled()
    expect(await setInstanceJurisdiction(fakeDb({ row: { jurisdiction: "ZA", currency: "ZAR" }, loans: 3 }).db, ask())).toMatchObject({ ok: false })
  })

  it("refuses an unknown code, ZA with loti, a missing reason and a missing actor", async () => {
    const { db } = fakeDb({ row: { jurisdiction: "ZA", currency: "ZAR" } })
    expect(await setInstanceJurisdiction(db, ask({ jurisdiction: "XX" }))).toMatchObject({ ok: false })
    expect(await setInstanceJurisdiction(db, ask({ jurisdiction: "ZA", currency: "LSL" }))).toMatchObject({ ok: false, error: expect.stringMatching(/ZAR only/) })
    expect(await setInstanceJurisdiction(db, ask({ reason: "  " }))).toMatchObject({ ok: false })
    expect(await setInstanceJurisdiction(db, ask({ actor: " " }))).toMatchObject({ ok: false })
  })
})
