import { describe, expect, it, vi } from "vitest"
import { AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION, InvalidAffordabilityDebtError } from "@/lib/affordability/snapshot"

const own = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock("@/lib/affordability/own-lender-debt-load", () => ({ loadOwnLenderDebts: own.load }))

import { attestationAffordable } from "./attestation-obligations"

const base = {
  tenantId: "t", applicationId: "a", clientId: "c", monthlyIncomeCents: 1_845_000, monthlyExpensesCents: 800_000,
  applicationDebts: [], clientDebts: [], bureauObligationsCents: 395_000, instalmentCents: 400_000, ndiBufferPct: 110,
}
const sibling = (proposedInstalmentCents: unknown) => ({ affordabilityResult: { schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION, submission: { inputs: { proposedInstalmentCents } } } })
const withDb = async (open: unknown[], loans: unknown[], over: object = {}) => {
  own.load.mockReset().mockResolvedValue({ lenderNames: [], loans })
  const findMany = vi.fn(async () => open)
  return { result: await attestationAffordable({ loanApplication: { findMany } } as never, { ...base, ...over }), findMany }
}

describe("attestationAffordable", () => {
  it("passes on the bureau figure alone with nothing else outstanding", async () => {
    expect((await withDb([], [])).result).toBe(true)
  })

  it("counts an approved sibling on top of the bureau figure: it is the case max(declared, bureau) absorbs", async () => {
    expect((await withDb([], [{ instalmentCents: 400_000 }])).result).toBe(false)
  })

  it("counts an open sibling on top, and asks only for this client's other submitted applications", async () => {
    const { result, findMany } = await withDb([sibling(400_000)], [])
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t", clientId: "c", id: { not: "a" }, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } }) }))
    expect(own.load).toHaveBeenCalledWith(expect.anything(), "t", "c", "a")
    expect(result).toBe(false)
  })

  it("takes the higher of declared and bureau, not the sum", async () => {
    expect((await withDb([], [], { clientDebts: [{ provider: "Synthetic Bank", type: "Loan", balance: 5_000_000, monthlyInstalment: 300_000 }] })).result).toBe(true)
    expect((await withDb([], [], { clientDebts: [{ provider: "Synthetic Bank", type: "Loan", balance: 5_000_000, monthlyInstalment: 1_000_000 }] })).result).toBe(false)
  })

  it("refers when uncertain: an instalment nobody priced, an approval with no recorded instalment, a loan with no schedule, debts it cannot read", async () => {
    expect((await withDb([], [], { instalmentCents: null })).result).toBe(false)
    expect((await withDb([], [{ instalmentCents: null }])).result).toBe(false)
    expect((await withDb([sibling(0)], [])).result).toBe(true)
    expect((await withDb([sibling(undefined)], [])).result).toBe(false)
    expect((await withDb([{ affordabilityResult: null }], [])).result).toBe(false)
    own.load.mockReset().mockRejectedValue(new InvalidAffordabilityDebtError("Approved application X", "has no recorded instalment"))
    expect(await attestationAffordable({ loanApplication: { findMany: async () => [] } } as never, base)).toBe(false)
  })

  it("does not swallow an infrastructure failure", async () => {
    own.load.mockReset().mockRejectedValue(new Error("connection lost"))
    await expect(attestationAffordable({ loanApplication: { findMany: async () => [] } } as never, base)).rejects.toThrow("connection lost")
  })
})
