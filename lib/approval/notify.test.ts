import { describe, expect, it, vi } from "vitest"
import { approversForLevel } from "./notify"
import type { MatrixLevel } from "./types"

const levels: MatrixLevel[] = [
  { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
  { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
]
const now = new Date("2026-11-02T10:00:00Z")

interface Person { id: string; role: string; active: boolean; isSystem: boolean; branchId?: string | null }
interface UserWhere { id?: { in?: string[]; notIn?: string[] }; active?: boolean; isSystem?: boolean; role?: { in: string[] } }

/** A staff directory the queries are run against (honouring the filters the code passes), and the delegations in force. */
function tx(directory: Person[], delegateIds: string[]) {
  return {
    user: {
      findMany: vi.fn(async ({ where }: { where: UserWhere }) => directory.filter((u) => (
        (where.active === undefined || u.active === where.active) && (where.isSystem === undefined || u.isSystem === where.isSystem)
        && (!where.id?.in || where.id.in.includes(u.id)) && (!where.id?.notIn || !where.id.notIn.includes(u.id)) && (!where.role || where.role.in.includes(u.role))
      ))),
    },
    approvalDelegation: { findMany: vi.fn(async () => delegateIds.map((delegateId) => ({ delegateId, delegatorId: `boss-of-${delegateId}` }))) },
  }
}
const person = (id: string, role: string, over: Partial<Person> = {}): Person => ({ id, role, active: true, isSystem: false, ...over })
const input = { tenantId: "t1", levels, level: 2, amountCents: 500_000, branchId: "b1", exclude: ["maker"], now }

describe("approversForLevel", () => {
  it("is the active people whose own role level is exactly this one, plus current delegates, never the maker", async () => {
    const db = tx([person("bm1", "BRANCH_MANAGER"), person("la1", "LOAN_ADMIN"), person("la2", "LOAN_ADMIN"), person("maker", "BRANCH_MANAGER")], ["la2"])
    expect((await approversForLevel(db as never, input)).sort()).toEqual(["bm1", "la2"])
  })

  it("does not wake a delegate who has since left, or is the system account", async () => {
    const db = tx([person("gone", "LOAN_ADMIN", { active: false }), person("robot", "LOAN_ADMIN", { isSystem: true }), person("la2", "LOAN_ADMIN")], ["gone", "robot", "la2"])
    expect(await approversForLevel(db as never, input)).toEqual(["la2"])
  })
  it("a branch-scoped level wakes only those who hold it at the application's branch, and head office (F8)", async () => {
    const scoped = levels.map((l) => (l.level === 2 ? { ...l, branchScoped: true } : l))
    const directory = [
      person("here", "BRANCH_MANAGER", { branchId: "b1" }), person("elsewhere", "BRANCH_MANAGER", { branchId: "b2" }), person("office", "BRANCH_MANAGER", { branchId: null }),
      person("deputy-here", "LOAN_ADMIN"), person("boss-of-deputy-here", "BRANCH_MANAGER", { branchId: "b1" }),
      person("deputy-there", "LOAN_ADMIN"), person("boss-of-deputy-there", "BRANCH_MANAGER", { branchId: "b2" }),
    ]
    const found = await approversForLevel(tx(directory, ["deputy-here", "deputy-there"]) as never, { ...input, levels: scoped })
    expect(found.sort()).toEqual(["boss-of-deputy-here", "deputy-here", "here", "office"])
  })
})
