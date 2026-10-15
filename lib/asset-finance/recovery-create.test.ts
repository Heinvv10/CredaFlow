import { describe, expect, it, vi } from "vitest"
import { createRecoveryTx, RECOVERY_HOLDER_ONLY, RECOVERY_LOAN_STATUS } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"

// The pre-checks that answer before the database does (its own sentences, guardRecovery):
// the loan must be live, and the asset's current holder. Synthetic values only.
const input = { loanId: "loan_1", route: "NON_NCA_VOLUNTARY" as const, recoveredOn: "2026-10-15", location: "TEST Yard", condition: "Synthetic: fair" }
const actor = { tenantId: "t1", userId: "u1" }

function tx(loan: { status: string; assetId: string | null } | null, otherLive: number) {
  const create = vi.fn(async () => ({ id: "rec_1" }))
  const client = {
    loan: { findFirst: vi.fn(async () => (loan ? { id: "loan_1", ...loan } : null)), count: vi.fn(async () => otherLive) },
    recovery: { create },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { client: client as unknown as SigningTx, create, count: client.loan.count }
}

describe("createRecoveryTx pre-checks", () => {
  it.each(["COMPLETED", "CANCELLED", "WRITTEN_OFF", "RESTRUCTURED"])("refuses a %s loan with the database's sentence", async (status) => {
    const t = tx({ status, assetId: "a1" }, 0)
    expect(await createRecoveryTx(t.client, actor, input)).toEqual({ kind: "not_ready", reason: RECOVERY_LOAN_STATUS })
    expect(t.create).not.toHaveBeenCalled()
  })

  it("refuses a loan whose asset another live loan holds now", async () => {
    const t = tx({ status: "COMPLETED", assetId: "a1" }, 1)
    // the status rule answers first for an ended loan; an active loan on a shared asset is refused as the non-holder
    expect(await createRecoveryTx(t.client, actor, input)).toEqual({ kind: "not_ready", reason: RECOVERY_LOAN_STATUS })
    const active = tx({ status: "ACTIVE", assetId: "a1" }, 1)
    expect(await createRecoveryTx(active.client, actor, input)).toEqual({ kind: "not_ready", reason: RECOVERY_HOLDER_ONLY })
    expect(active.count).toHaveBeenCalledWith({ where: { tenantId: "t1", assetId: "a1", id: { not: "loan_1" }, status: { notIn: ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] } } })
    expect(active.create).not.toHaveBeenCalled()
  })

  it.each(["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF"])("opens a recovery on a %s loan that holds its asset", async (status) => {
    const t = tx({ status, assetId: "a1" }, 0)
    expect(await createRecoveryTx(t.client, actor, input)).toEqual({ kind: "done", id: "rec_1" })
    expect(t.create).toHaveBeenCalledOnce()
  })

  it("answers not_found for a loan with no asset or none of this lender's", async () => {
    expect(await createRecoveryTx(tx(null, 0).client, actor, input)).toEqual({ kind: "not_found" })
    expect(await createRecoveryTx(tx({ status: "ACTIVE", assetId: null }, 0).client, actor, input)).toEqual({ kind: "not_found" })
  })
})
