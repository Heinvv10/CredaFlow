// app/api/insurance/quotes/[id]/route.test.ts
//
// The quote detail read. It writes nothing, so the guards ARE the behaviour:
// the role gate, tenant scoping, and the fact that another tenant's quote is a
// 404 rather than a 403 that would confirm the id exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const { requireApiRole, findFirstQuote, tenantConfigFindUnique, logAudit } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findFirstQuote: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    insuranceQuote: { findFirst: findFirstQuote },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

import { GET } from "./route"

const QUOTE = {
  id: "quote-1",
  status: "QUOTED",
  adviceRecord: null,
  lives: [],
  product: { id: "product-1", code: "FUN", name: "Funeral", type: "FUNERAL_COVER" },
  rateTable: null,
}

const req = () => new NextRequest("http://localhost/api/insurance/quotes/quote-1")
const ctx = { params: Promise.resolve({ id: "quote-1" }) }

function roleRefusal() {
  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
}

beforeEach(() => {
  requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "reader@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  findFirstQuote.mockResolvedValue(QUOTE)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/insurance/quotes/[id]", () => {
  it("requires READONLY", async () => {
    await GET(req(), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("READONLY")
  })

  it("returns the guard's refusal and reads nothing behind it", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await GET(req(), ctx)

    expect(res.status).toBe(403)
    expect(findFirstQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("scopes the lookup to the caller's tenant", async () => {
    await GET(req(), ctx)
    expect(findFirstQuote).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote-1", tenantId: "tenant-1" } })
    )
  })

  it("returns 404 for another tenant's quote rather than 403", async () => {
    findFirstQuote.mockResolvedValue(null)

    const res = await GET(req(), ctx)

    expect(res.status).toBe(404)
    // Not 403: a 403 would confirm the id exists in some other tenant.
    expect(await res.json()).toEqual({ error: "Quote not found" })
  })

  it("computes allowedTransitions server-side rather than leaving it to the UI", async () => {
    // Without an advice record, a QUOTED quote may only be rejected or expired
    // — ADVICE_RECORDED is withheld. A UI reimplementing this would drift.
    const res = await GET(req(), ctx)

    expect(res.status).toBe(200)
    expect((await res.json()).allowedTransitions).toEqual(["REJECTED", "EXPIRED"])
  })

  it("offers ADVICE_RECORDED once a record exists", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, adviceRecord: { id: "advice-1" } })

    const res = await GET(req(), ctx)

    expect((await res.json()).allowedTransitions).toContain("ADVICE_RECORDED")
  })

  it("does NOT ship covered-lives ID numbers to a READONLY caller", async () => {
    // G4: this handler answers the widest role in the module, and `include`
    // shipped every InsuredLife column — the idNumber and date of birth of a
    // client's spouse, children and parents, none of whom are clients. The
    // select must not name idNumber at all.
    await GET(req(), ctx)

    const args = findFirstQuote.mock.calls[0][0] as {
      select?: { lives?: { select?: Record<string, unknown> } }
      include?: unknown
    }
    expect(args.include).toBeUndefined()
    expect(args.select?.lives?.select).toBeTruthy()
    expect(args.select?.lives?.select).not.toHaveProperty("idNumber")
  })

  it("writes no audit row for a read", async () => {
    await GET(req(), ctx)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
