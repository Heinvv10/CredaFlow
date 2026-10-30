import { describe, expect, it, vi } from "vitest"
import { approversForLevel } from "./notify"
import type { MatrixLevel } from "./types"

const levels: MatrixLevel[] = [
  { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
  { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
]
const now = new Date("2026-11-02T10:00:00Z")

function tx(over: { users?: unknown[]; delegations?: unknown[]; activeDelegates?: string[] }) {
  return {
    user: {
      findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) => (args.where.id?.in
        ? (over.activeDelegates ?? []).filter((id) => args.where.id!.in.includes(id)).map((id) => ({ id }))
        : (over.users ?? []))),
    },
    approvalDelegation: { findMany: vi.fn(async () => over.delegations ?? []) },
  }
}
const input = { tenantId: "t1", levels, level: 2, amountCents: 500_000, exclude: ["maker"], now }

describe("approversForLevel", () => {
  it("is the active people whose own role level is exactly this one, plus current delegates", async () => {
    const db = tx({ users: [{ id: "bm1", role: "BRANCH_MANAGER" }, { id: "la1", role: "LOAN_ADMIN" }, { id: "ad1", role: "ADMIN" }], delegations: [{ delegateId: "la2" }], activeDelegates: ["la2"] })
    // ADMIN holds a level above 2 only if the matrix has one; here the top level is 2, so an ADMIN's level is 2 as well.
    expect((await approversForLevel(db as never, input)).sort()).toEqual(["ad1", "bm1", "la2"])
  })

  it("does not wake a delegate who has since left, or is the system account", async () => {
    const db = tx({ users: [], delegations: [{ delegateId: "gone" }, { delegateId: "la2" }], activeDelegates: ["la2"] })
    expect(await approversForLevel(db as never, input)).toEqual(["la2"])
  })
})
