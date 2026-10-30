import { describe, expect, it, vi } from "vitest"
import { approversForLevel } from "./notify"
import type { MatrixLevel } from "./types"

const levels: MatrixLevel[] = [
  { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
  { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
]
const now = new Date("2026-11-02T10:00:00Z")

interface Person { id: string; role: string; active: boolean; isSystem: boolean }
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
    approvalDelegation: { findMany: vi.fn(async () => delegateIds.map((delegateId) => ({ delegateId }))) },
  }
}
const person = (id: string, role: string, over: Partial<Person> = {}): Person => ({ id, role, active: true, isSystem: false, ...over })
const input = { tenantId: "t1", levels, level: 2, amountCents: 500_000, exclude: ["maker"], now }

describe("approversForLevel", () => {
  it("is the active people whose own role level is exactly this one, plus current delegates, never the maker", async () => {
    const db = tx([person("bm1", "BRANCH_MANAGER"), person("la1", "LOAN_ADMIN"), person("la2", "LOAN_ADMIN"), person("maker", "BRANCH_MANAGER")], ["la2"])
    expect((await approversForLevel(db as never, input)).sort()).toEqual(["bm1", "la2"])
  })

  it("does not wake a delegate who has since left, or is the system account", async () => {
    const db = tx([person("gone", "LOAN_ADMIN", { active: false }), person("robot", "LOAN_ADMIN", { isSystem: true }), person("la2", "LOAN_ADMIN")], ["gone", "robot", "la2"])
    expect(await approversForLevel(db as never, input)).toEqual(["la2"])
  })
})
