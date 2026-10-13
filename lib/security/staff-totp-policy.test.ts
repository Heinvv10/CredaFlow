import { describe, expect, it, vi } from "vitest"
import { applyStaffTotpRequired, STAFF_TOTP_REQUIRED_DEFAULT } from "./staff-totp-policy"

type Tx = Parameters<typeof applyStaffTotpRequired>[0]

function fakeTx(stored: { requireStaffTotp: boolean } | null, signedOut = 3) {
  const calls = { upsert: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: signedOut }), audit: vi.fn() }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    tenantConfig: { findUnique: vi.fn().mockResolvedValue(stored), upsert: calls.upsert },
    user: { updateMany: calls.updateMany },
    auditLog: { create: calls.audit },
  } as unknown as Tx
  return { tx, calls }
}
const actor = { id: "u-super", email: "super@lender.example" }

describe("applyStaffTotpRequired", () => {
  it("defaults to required when the tenant has no config row", () => {
    expect(STAFF_TOTP_REQUIRED_DEFAULT).toBe(true)
  })

  it("writes the flag and one audit row with the old value, new value and actor", async () => {
    const { tx, calls } = fakeTx({ requireStaffTotp: true })
    const result = await applyStaffTotpRequired(tx, { tenantId: "t1", actor, required: false, ipAddress: "10.0.0.1" })
    expect(result).toEqual({ changed: true, required: false, signedOut: 3 })
    expect(calls.upsert).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      update: { requireStaffTotp: false },
      create: { tenantId: "t1", requireStaffTotp: false },
    })
    expect(calls.audit).toHaveBeenCalledTimes(1)
    expect(calls.audit.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      userId: "u-super",
      userEmail: "super@lender.example",
      action: "STAFF_TOTP_POLICY_UPDATED",
      entity: "TenantConfig",
      entityId: "t1",
      oldValue: { requireStaffTotp: true },
      newValue: { requireStaffTotp: false, signedOutUsers: 3 },
      ipAddress: "10.0.0.1",
    })
  })

  it("treats a missing config row as on, so switching it on is no change", async () => {
    const { tx, calls } = fakeTx(null)
    const result = await applyStaffTotpRequired(tx, { tenantId: "t1", actor, required: true })
    expect(result).toEqual({ changed: false, required: true, signedOut: 0 })
    expect(calls.upsert).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
    expect(calls.updateMany).not.toHaveBeenCalled()
  })

  it("takes the tenant's advisory lock before it reads, so a first switch (no row to lock) cannot race", async () => {
    const { tx } = fakeTx({ requireStaffTotp: true })
    const order: string[] = []
    ;(tx.$executeRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (strings: TemplateStringsArray) => { order.push(strings.join("?")); return 1 })
    ;(tx.tenantConfig.findUnique as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("read"); return { requireStaffTotp: true } })
    await applyStaffTotpRequired(tx, { tenantId: "t1", actor, required: false })
    expect(order[0]).toContain("pg_advisory_xact_lock")
    expect(order.indexOf("read")).toBeGreaterThan(0)
  })

  it("ends the sessions of this tenant's unenrolled staff, but not the actor's", async () => {
    const { tx, calls } = fakeTx({ requireStaffTotp: false })
    await applyStaffTotpRequired(tx, { tenantId: "t1", actor, required: true })
    expect(calls.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", id: { not: "u-super" }, totpEnabled: false, totpSecret: null },
      data: { tokenVersion: { increment: 1 } },
    })
  })
})
