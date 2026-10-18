import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Sim } from "./context"

interface Cost { id: string; supplierInvoiceRef: string; status: string }
interface Sale { id: string; status: string; priceInclVatCents: number; buyerIdentifier: string; valuationId: string }
interface RecoveryFixture {
  id: string; tenantId: string; assetId: string; status: string; valuationId: string;
  valuationNoticeReceivedOn: Date | null; valuationNoticeIssuedOn: Date; valuationNoticePath: string;
  valuationNoticeSha256: string; valuationReceiptReference: string; costs: Cost[]; sales: Sale[];
}
const mocks = vi.hoisted(() => ({ rows: [] as RecoveryFixture[], valuation: null as { id: string } | null, posts: [] as { who: string; path: string; body: Record<string, unknown> }[], refusal: "", clock: "2026-10-18", ensure: vi.fn(), cron: vi.fn() }))
vi.mock("../sim/readonly-db", () => ({ readDb: () => ({ tenant: { findUniqueOrThrow: async () => ({ id: "tenant" }) }, recovery: { findMany: async () => mocks.rows }, assetValuation: { findFirst: async () => mocks.valuation } }) }))
vi.mock("../../../prisma/demo-lender", () => ({ demoLender: () => ({ slug: "tsela" }) }))
vi.mock("../sim/clock", () => ({ now: () => new Date(`${mocks.clock}T10:00:00Z`) }))
vi.mock("../servicing/setup", () => ({ ensureActorSessions: mocks.ensure }))
vi.mock("../sim/cron", () => ({ runCronJob: mocks.cron }))
import { continueSeedRecovery } from "./seed-recovery"

function fixture(received = "2026-04-01"): RecoveryFixture {
  return { id: "recovery", tenantId: "tenant", assetId: "asset", status: "VALUATION_NOTICE_ISSUED", valuationId: "original", valuationNoticeReceivedOn: new Date(received), valuationNoticeIssuedOn: new Date("2026-04-01"), valuationNoticePath: "immutable.pdf", valuationNoticeSha256: "original-sha", valuationReceiptReference: "Original synthetic receipt", costs: [], sales: [] }
}
function sim(): Sim {
  const post = (who: string) => async (path: string, body: Record<string, unknown> = {}) => {
    mocks.posts.push({ who, path, body })
    if (path.endsWith(mocks.refusal) && mocks.refusal) throw Error("normal guard refusal")
    const r = mocks.rows[0]
    if (path.endsWith("/valuations")) { mocks.valuation = { id: "fresh" }; return { status: 201, json: { id: "fresh" } } }
    if (path.endsWith("/list")) r.status = "LISTED"
    if (path.endsWith("/costs")) r.costs.push({ id: "cost", supplierInvoiceRef: "STR-TLB-001", status: "PENDING" })
    if (path.endsWith("/decide")) r.costs[0].status = "APPROVED"
    if (path.endsWith("/sales")) r.sales.push({ id: "sale", status: "PENDING_APPROVAL", priceInclVatCents: 40_000_000, buyerIdentifier: "2098/700001/07", valuationId: "fresh" })
    if (path.endsWith("/approve")) r.sales[0].status = "APPROVED"
    if (path.endsWith("/complete")) { r.sales[0].status = "COMPLETED"; r.status = "SOLD" }
    if (path.endsWith("/proceeds")) r.status = "PROCEEDS_APPLIED"
    if (path.endsWith("/final-notice")) r.status = "FINAL_NOTICE_ISSUED"
    if (path.endsWith("/outcome")) r.status = "SHORTFALL_OPEN"
    return { status: 200, json: { kind: "done", id: path.endsWith("/costs") ? "cost" : "sale" } }
  }
  return { window: { until: mocks.clock }, actors: { officer: { user: { id: "officer", role: "CREDIT_OFFICER", tenantId: "tenant", totpVerified: true }, post: post("officer") }, admin: { user: { id: "admin", role: "ADMIN", tenantId: "tenant", totpVerified: true }, post: post("admin") } } } as unknown as Sim
}

describe("end-window seeded TLB recovery continuation", () => {
  beforeEach(() => { mocks.rows = [fixture()]; mocks.posts = []; mocks.valuation = null; mocks.refusal = ""; mocks.clock = "2026-10-18"; mocks.ensure.mockReset(); mocks.cron.mockReset().mockResolvedValue({ status: 200 }) })
  it("uses normal guarded routes and distinct approvers with current dates, leaving original notice untouched", async () => {
    const before = { ...mocks.rows[0] }
    await continueSeedRecovery(sim())
    expect(mocks.rows[0].status).toBe("SHORTFALL_OPEN")
    expect(mocks.posts.map(p => p.path.split("/").at(-1))).toEqual(["list", "costs", "decide", "valuations", "sales", "approve", "complete", "proceeds", "final-notice", "outcome"])
    expect(mocks.posts.find(p => p.path.endsWith("/proceeds"))).toEqual(expect.objectContaining({ who: "admin", body: {} }))
    expect(mocks.posts.find(p => p.path.endsWith("/decide"))?.who).toBe("admin")
    expect(mocks.posts.find(p => p.path.endsWith("/approve"))?.who).toBe("admin")
    expect(mocks.posts.find(p => p.path.endsWith("/valuations"))?.body).toMatchObject({ valuedOn: "2026-10-18", amountCents: 45_000_000, source: "ASSESSOR" })
    for (const key of ["valuationId", "valuationNoticeReceivedOn", "valuationNoticePath", "valuationNoticeSha256"] as const) expect(mocks.rows[0][key]).toEqual(before[key as keyof typeof before])
    expect(mocks.cron).toHaveBeenCalledWith(expect.objectContaining({ name: "dpd-update" }))
  })
  it("is idempotent after completion and resumes a listed pending cost without duplicating it", async () => {
    mocks.rows[0].status = "LISTED"; mocks.rows[0].costs.push({ id: "cost", supplierInvoiceRef: "STR-TLB-001", status: "PENDING" })
    await continueSeedRecovery(sim()); const count = mocks.posts.length
    await continueSeedRecovery(sim())
    expect(mocks.posts).toHaveLength(count)
    expect(mocks.posts.some(p => p.path.endsWith("/costs"))).toBe(false)
    expect(mocks.posts.filter(p => p.path.endsWith("/decide"))).toHaveLength(1)
  })
  it("does not list before or on the tenth SA business day, or without receipt", async () => {
    mocks.rows[0] = fixture("2026-10-05")
    await continueSeedRecovery(sim()); expect(mocks.posts).toHaveLength(0)
    mocks.clock = "2026-10-19" // Exactly ten business days from Oct5: still in the protected window.
    await continueSeedRecovery(sim()); expect(mocks.posts).toHaveLength(0)
    mocks.rows[0].valuationNoticeReceivedOn = null
    await continueSeedRecovery(sim()); expect(mocks.posts).toHaveLength(0)
  })
  it("stops on a normal guard refusal without proceeding or retrying", async () => {
    mocks.refusal = "/list"
    await expect(continueSeedRecovery(sim())).rejects.toThrow("normal guard refusal")
    expect(mocks.posts).toHaveLength(1)
  })
  it("refuses a shared or unverified staff identity before any mutation", async () => {
    const s = sim(); s.actors.admin.user!.id = "officer"
    await expect(continueSeedRecovery(s)).rejects.toThrow(/distinct/)
    expect(mocks.posts).toHaveLength(0)
    s.actors.admin.user!.id = "admin"; s.actors.admin.user!.totpVerified = false
    await expect(continueSeedRecovery(s)).rejects.toThrow(/verified/)
  })

  it("counts SA public holidays in the protected window", async () => {
    mocks.rows[0] = fixture("2026-03-20"); mocks.clock = "2026-04-07" // Good Friday and Family Day do not count.
    await continueSeedRecovery(sim()); expect(mocks.posts).toHaveLength(0)
  })

  it("reuses a previously recorded current assessment after an interrupted valuation step", async () => {
    mocks.valuation = { id: "fresh" }
    await continueSeedRecovery(sim())
    expect(mocks.posts.some(p => p.path.endsWith("/valuations"))).toBe(false)
    expect(mocks.posts.find(p => p.path.endsWith("/sales"))?.body.valuationId).toBe("fresh")
  })

  it.each(["SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"])("resumes %s without duplicating earlier actions", async status => {
    mocks.rows[0].status = status
    await continueSeedRecovery(sim())
    expect(mocks.posts.some(p => /\/(list|costs|sales|valuations)$/.test(p.path))).toBe(false)
    expect(mocks.rows[0].status).toBe("SHORTFALL_OPEN")
  })

  it.each(["/proceeds", "/final-notice", "/outcome"])("does not bypass a later %s refusal", async refusal => {
    mocks.rows[0].status = refusal === "/proceeds" ? "SOLD" : refusal === "/final-notice" ? "PROCEEDS_APPLIED" : "FINAL_NOTICE_ISSUED"
    mocks.refusal = refusal
    await expect(continueSeedRecovery(sim())).rejects.toThrow("normal guard refusal")
    expect(mocks.posts).toHaveLength(1)
    expect(mocks.cron).not.toHaveBeenCalled()
  })
  it("retries only DPD if the guarded outcome committed before the refresh failed", async () => {
    mocks.rows[0].status = "FINAL_NOTICE_ISSUED"
    mocks.cron.mockResolvedValueOnce({ status: 500 })
    await expect(continueSeedRecovery(sim())).rejects.toThrow(/DPD refresh refused/)
    expect(mocks.rows[0].status).toBe("SHORTFALL_OPEN")
    const count = mocks.posts.length
    await continueSeedRecovery(sim())
    expect(mocks.posts).toHaveLength(count)
    expect(mocks.cron).toHaveBeenCalledTimes(2)
  })

})
