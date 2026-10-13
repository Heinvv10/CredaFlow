import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The 30-day re-check window on director/trustee bureau checks (review M3).
// The route, the permission map and the recent-check query run for real;
// session, Prisma, the provider call and the audit writers are stubbed.
const m = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  dealFindFirst: vi.fn(),
  checkFindMany: vi.fn(),
  subjects: vi.fn(),
  runCheck: vi.fn(),
  logAuditStrict: vi.fn(),
  auditRefusal: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: true }) },
    assetFinanceDeal: { findFirst: m.dealFindFirst },
    creditBureauCheck: { findMany: m.checkFindMany },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/asset-finance/deal-bureau", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/deal-bureau")>()),
  dealBureauSubjects: m.subjects,
  runDealBureauCheck: m.runCheck,
}))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async (_t: string, id: string) => ({ id }) }))

import { POST } from "./route"

const signIn = (role: string, id = "user-1") =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const run = (body: unknown = {}) => POST(new NextRequest("http://localhost/api/asset-finance/deals/deal-1/bureau-checks", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "deal-1" }) })

beforeEach(() => {
  vi.clearAllMocks()
  signIn("CREDIT_OFFICER")
  m.dealFindFirst.mockResolvedValue({ id: "deal-1", status: "SUBMITTED", entityId: "ent-1", applicationId: "app-1" })
  m.subjects.mockResolvedValue([
    { clientId: "c-recent", role: "DIRECTOR", trusteeKind: null },
    { clientId: "c-new", role: "DIRECTOR", trusteeKind: null },
  ])
  m.checkFindMany.mockResolvedValue([{ clientId: "c-recent" }])
  m.runCheck.mockResolvedValue("stored")
})

describe("POST …/deals/[id]/bureau-checks: 30-day re-check window", () => {
  it("looks for successful checks of this application's people stored in the last 30 days", async () => {
    const before = Date.now()
    await run()
    const where = m.checkFindMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: "tenant-1", applicationId: "app-1", clientId: { in: ["c-recent", "c-new"] }, ok: true })
    const since = (where.createdAt.gte as Date).getTime()
    expect(before - since).toBeGreaterThanOrEqual(30 * 86_400_000 - 1_000)
    expect(before - since).toBeLessThanOrEqual(30 * 86_400_000 + 1_000)
  })

  it("skips a person checked within the window and checks the rest", async () => {
    const res = await run()
    expect(res.status).toBe(200)
    expect(m.runCheck).toHaveBeenCalledTimes(1)
    expect(m.runCheck).toHaveBeenCalledWith("tenant-1", "app-1", expect.objectContaining({ clientId: "c-new" }))
    expect((await res.json()).results).toEqual([
      { clientId: "c-recent", role: "DIRECTOR", outcome: "recent" },
      { clientId: "c-new", role: "DIRECTOR", outcome: "stored" },
    ])
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "ASSET_DEAL_BUREAU_CHECKED" }))
  })

  it("refuses force to a user without decide_asset_finance 403, audited, enquiring on no one", async () => {
    const res = await run({ force: true })
    expect(res.status).toBe(403)
    expect(m.runCheck).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_DEAL_BUREAU_FORCE_REFUSED", entityId: "deal-1", reason: "insufficient_role", status: 403,
    }))
  })

  it("lets a decide_asset_finance user force a re-check, audited as a forced re-run naming who was re-checked", async () => {
    signIn("LOAN_ADMIN", "admin-1")
    const res = await run({ force: true })
    expect(res.status).toBe(200)
    expect(m.runCheck).toHaveBeenCalledTimes(2)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_DEAL_BUREAU_FORCED_RERUN",
      userId: "admin-1",
      newValue: expect.objectContaining({ forced: true, recheckedClientIds: ["c-recent"] }),
    }))
  })

  it("treats anything but force: true as a normal run", async () => {
    signIn("LOAN_ADMIN")
    for (const body of [{ force: "true" }, { force: 1 }, null]) {
      m.runCheck.mockClear()
      expect((await run(body)).status).toBe(200)
      expect(m.runCheck).toHaveBeenCalledTimes(1)
    }
  })
})
