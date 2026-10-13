import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

// Applications held in memory; groupBy honours `by` and the status / not-null
// parts of `where`, so the page's attribution is exercised, not its query text.
type App = { assignedToId: string | null; approvedById: string | null; status: string; approvedAmount: number }
const { db } = vi.hoisted(() => ({ db: { apps: [] as App[] } }))

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

vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u1" })) }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async () => [
        { id: "adv", name: "Advisor Ann", email: "ann@example.com", role: "LOAN_OFFICER" },
        { id: "boss", name: "Approver Bo", email: "bo@example.com", role: "SUPER_ADMIN" },
      ]),
    },
    loanApplication: { groupBy: vi.fn(async (args: never) => groupBy(args)) },
    lead: { groupBy: vi.fn(async () => []) },
  },
}))

import AdvisorReportPage from "./page"

const cells = (html: string, name: string) => {
  const row = html.split("<tr").find((r) => r.includes(name)) ?? ""
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
}

describe("Advisor report", () => {
  it("credits approvals to the advisor the application is assigned to, like every other column", async () => {
    // Three of Ann's applications, all approved by Bo and disbursed.
    db.apps = Array.from({ length: 3 }, () => ({ assignedToId: "adv", approvedById: "boss", status: "DISBURSED", approvedAmount: 500_000 }))
    const html = renderToStaticMarkup(await AdvisorReportPage())
    // Leads, Applications, Approved, Disbursed follow name + role.
    expect(cells(html, "Advisor Ann").slice(2, 6)).toEqual(["0", "3", "3", "3"])
    expect(html).toContain("R 15,000.00")
    expect(cells(html, "Approver Bo").slice(2, 6)).toEqual(["0", "0", "0", "0"])
  })
})
