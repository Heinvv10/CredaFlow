import { describe, expect, it, vi } from "vitest"
import { applyDecisionRecordRetention, isRetentionMonths } from "./policy"

type Tx = Parameters<typeof applyDecisionRecordRetention>[0]

function fakeTx(stored: { decisionRecordRetentionMonths: number | null } | null) {
  const calls = { upsert: vi.fn(), audit: vi.fn() }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    tenantConfig: { findUnique: vi.fn().mockResolvedValue(stored), upsert: calls.upsert },
    auditLog: { create: calls.audit },
  } as unknown as Tx
  return { tx, calls }
}
const actor = { id: "u-super", email: "super@lender.example" }

describe("applyDecisionRecordRetention", () => {
  it("writes the period and one audit row with the old value, new value and actor", async () => {
    const { tx, calls } = fakeTx({ decisionRecordRetentionMonths: null })
    expect(await applyDecisionRecordRetention(tx, { tenantId: "t1", actor, months: 60, ipAddress: "10.0.0.1" })).toEqual({ changed: true, months: 60 })
    expect(calls.upsert).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      update: { decisionRecordRetentionMonths: 60 },
      create: { tenantId: "t1", decisionRecordRetentionMonths: 60 },
    })
    expect(calls.audit).toHaveBeenCalledTimes(1)
    expect(calls.audit.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1", userId: "u-super", userEmail: "super@lender.example", action: "DECISION_RECORD_RETENTION_UPDATED",
      entity: "TenantConfig", entityId: "t1",
      oldValue: { decisionRecordRetentionMonths: null }, newValue: { decisionRecordRetentionMonths: 60 }, ipAddress: "10.0.0.1",
    })
  })

  it("switches it off with null, audited", async () => {
    const { tx, calls } = fakeTx({ decisionRecordRetentionMonths: 36 })
    expect(await applyDecisionRecordRetention(tx, { tenantId: "t1", actor, months: null })).toEqual({ changed: true, months: null })
    expect(calls.audit.mock.calls[0][0].data).toMatchObject({ oldValue: { decisionRecordRetentionMonths: 36 }, newValue: { decisionRecordRetentionMonths: null } })
  })

  it.each([[null, null], [60, 60]])("treats %s over a stored %s as no change: nothing written, nothing audited", async (stored, months) => {
    const { tx, calls } = fakeTx(stored === null ? null : { decisionRecordRetentionMonths: stored })
    expect(await applyDecisionRecordRetention(tx, { tenantId: "t1", actor, months })).toEqual({ changed: false, months })
    expect(calls.upsert).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
  })

  it("takes the tenant's advisory lock before it reads", async () => {
    const { tx } = fakeTx({ decisionRecordRetentionMonths: null })
    const order: string[] = []
    ;(tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (strings: TemplateStringsArray) => { order.push(strings.join("?")); return 1 })
    ;(tx.tenantConfig.findUnique as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("read"); return null })
    await applyDecisionRecordRetention(tx, { tenantId: "t1", actor, months: 12 })
    expect(order[0]).toContain("pg_advisory_xact_lock")
    expect(order.indexOf("read")).toBeGreaterThan(0)
  })
})

describe("isRetentionMonths", () => {
  it.each([60, 61, 600])("accepts %s", (v) => expect(isRetentionMonths(v)).toBe(true))
  it.each([0, -1, 1, 36, 59, 601, 1.5, NaN, "12", null, undefined, {}])("refuses %j", (v) => expect(isRetentionMonths(v)).toBe(false))
})
