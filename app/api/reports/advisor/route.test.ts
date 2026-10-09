import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

// Applications held in memory; groupBy honours `by` and the status / not-null
// parts of `where`, so the route's attribution is exercised, not its query text.
type App = { assignedToId: string | null; approvedById: string | null; status: string; approvedAmount: number }
type User = { id: string; tenantId: string; name: string; email: string; role: string }
const { db } = vi.hoisted(() => ({ db: { apps: [] as App[], users: [] as User[] } }))

function groupBy({ by, where }: { by: (keyof App)[]; where: Record<string, unknown> }) {
  const key = by[0]
  const status = where.status as string | { in: string[] } | undefined
  const rows = db.apps.filter((a) =>
    a[key] !== null
    && (status === undefined || (typeof status === "string" ? a.status === status : status.in.includes(a.status))))
  const groups = new Map<string, App[]>()
  for (const a of rows) groups.set(a[key] as string, [...(groups.get(a[key] as string) ?? []), a])
  return [...groups].map(([id, apps]) => ({
    [key]: id, _count: apps.length, _sum: { approvedAmount: apps.reduce((s, a) => s + a.approvedAmount, 0) },
  }))
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "u1" } })) }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: vi.fn(async () => ({ id: "tenant-1" })) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      // Honours the tenant filter the way Prisma would; a filter that is not a plain id matches every tenant.
      findMany: vi.fn(async ({ where }: { where: { tenantId?: unknown } }) =>
        db.users.filter((u) => typeof where.tenantId !== "string" || u.tenantId === where.tenantId)),
    },
    loanApplication: { groupBy: vi.fn(async (args: never) => groupBy(args)) },
    lead: { groupBy: vi.fn(async () => []) },
  },
}))

import { GET } from "./route"

describe("GET /api/reports/advisor", () => {
  it("credits approvals to the advisor the application is assigned to, like every other column", async () => {
    // Three of Ann's applications, all approved by Bo and disbursed.
    db.users = [
      { id: "adv", tenantId: "tenant-1", name: "Advisor Ann", email: "ann@example.com", role: "LOAN_OFFICER" },
      { id: "boss", tenantId: "tenant-1", name: "Approver Bo", email: "bo@example.com", role: "SUPER_ADMIN" },
    ]
    db.apps = Array.from({ length: 3 }, () => ({ assignedToId: "adv", approvedById: "boss", status: "DISBURSED", approvedAmount: 500_000 }))
    const res = await GET(new NextRequest("http://localhost/api/reports/advisor"))
    const { data } = await res.json()
    expect(data).toEqual([
      expect.objectContaining({ id: "adv", applicationsAssigned: 3, loansApproved: 3, approvedAmount: 1_500_000, loansDisbursed: 3 }),
    ])
  })

  it("lists only this tenant's staff, even one from another tenant with work assigned here", async () => {
    db.users = [
      { id: "adv", tenantId: "tenant-1", name: "Advisor Ann", email: "ann@example.com", role: "LOAN_OFFICER" },
      { id: "outsider", tenantId: "tenant-2", name: "Other Tenant", email: "x@other.example", role: "LOAN_OFFICER" },
    ]
    db.apps = [
      { assignedToId: "adv", approvedById: null, status: "SUBMITTED", approvedAmount: 0 },
      { assignedToId: "outsider", approvedById: null, status: "SUBMITTED", approvedAmount: 0 },
    ]
    const { data } = await (await GET(new NextRequest("http://localhost/api/reports/advisor"))).json()
    expect(data.map((u: { id: string }) => u.id)).toEqual(["adv"])
  })
})
