import { describe, expect, it, vi } from "vitest"
import { pseudonymiseTenantDecisionRecords, type RetentionDb } from "./job"

const asOf = new Date("2027-06-01T00:00:00.000Z")

function fakeDb(months: number | null, count: number) {
  const calls = { queryRaw: vi.fn().mockResolvedValue([{ count }]), audit: vi.fn() }
  const tx = {
    tenantConfig: { findUnique: vi.fn().mockResolvedValue(months === null ? null : { decisionRecordRetentionMonths: months }) },
    $queryRaw: calls.queryRaw,
    auditLog: { create: calls.audit },
  }
  return { db: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as RetentionDb, calls }
}

describe("pseudonymiseTenantDecisionRecords", () => {
  it("does not call the database function for a lender with no period", async () => {
    const { db, calls } = fakeDb(null, 5)
    expect(await pseudonymiseTenantDecisionRecords("t1", asOf, db)).toEqual({ retentionMonths: null, pseudonymised: 0 })
    expect(calls.queryRaw).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
  })

  it("audits a run that changed rows, with counts and no subject", async () => {
    const { db, calls } = fakeDb(36, 4)
    expect(await pseudonymiseTenantDecisionRecords("t1", asOf, db)).toEqual({ retentionMonths: 36, pseudonymised: 4 })
    expect(calls.audit.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1", action: "DECISION_RECORDS_PSEUDONYMISED", entity: "TenantConfig", entityId: "t1",
      newValue: { retentionMonths: 36, pseudonymised: 4, asOf: asOf.toISOString() },
    })
  })

  it("audits nothing when nothing had aged", async () => {
    const { db, calls } = fakeDb(36, 0)
    expect(await pseudonymiseTenantDecisionRecords("t1", asOf, db)).toEqual({ retentionMonths: 36, pseudonymised: 0 })
    expect(calls.audit).not.toHaveBeenCalled()
  })
})
