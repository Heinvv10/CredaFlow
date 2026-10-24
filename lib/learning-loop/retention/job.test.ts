import { describe, expect, it, vi } from "vitest"
import { pseudonymiseTenantDecisionRecords, type RetentionDb } from "./job"

function fakeDb(months: number | null, count: number) {
  const order: string[] = []
  const calls = {
    order,
    queryRaw: vi.fn(async () => { order.push("function"); return [{ count }] }),
    audit: vi.fn(),
  }
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => { order.push(strings.join("?")); return 1 }),
    tenantConfig: { findUnique: vi.fn().mockResolvedValue(months === null ? null : { decisionRecordRetentionMonths: months }) },
    $queryRaw: calls.queryRaw,
    auditLog: { create: calls.audit },
  }
  return { db: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as RetentionDb, calls }
}

describe("pseudonymiseTenantDecisionRecords", () => {
  it("does not call the database function for a lender with no period", async () => {
    const { db, calls } = fakeDb(null, 5)
    expect(await pseudonymiseTenantDecisionRecords("t1", db)).toEqual({ retentionMonths: null, pseudonymised: 0 })
    expect(calls.queryRaw).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
  })

  it("names its tenant to the transaction before the database function reads it", async () => {
    const { db, calls } = fakeDb(36, 1)
    await pseudonymiseTenantDecisionRecords("t1", db)
    expect(calls.order[0]).toContain("set_config('app.tenant_id'")
    expect(calls.order.indexOf("function")).toBeGreaterThan(0)
  })

  it("audits a run that changed rows, with counts and no subject", async () => {
    const { db, calls } = fakeDb(36, 4)
    expect(await pseudonymiseTenantDecisionRecords("t1", db)).toEqual({ retentionMonths: 36, pseudonymised: 4 })
    expect(calls.audit.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1", action: "DECISION_RECORDS_PSEUDONYMISED", entity: "TenantConfig", entityId: "t1",
      newValue: { retentionMonths: 36, pseudonymised: 4 },
    })
  })

  it("audits nothing when nothing had aged", async () => {
    const { db, calls } = fakeDb(36, 0)
    expect(await pseudonymiseTenantDecisionRecords("t1", db)).toEqual({ retentionMonths: 36, pseudonymised: 0 })
    expect(calls.audit).not.toHaveBeenCalled()
  })
})
