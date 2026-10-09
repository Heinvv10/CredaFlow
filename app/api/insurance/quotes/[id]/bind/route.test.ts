// Route-level proof that the bind is not priced by its caller.
//
// The unit test in lib/insurance/policy/bind.test.ts shows `bindQuote` has no
// premium parameter. This shows the whole HTTP path: a request that TRIES to
// name a premium and a sum assured is served a policy carrying the quote's
// figures instead, with the request's numbers appearing nowhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { signDraftToken } from "@/lib/insurance/disclosure-token"

const { policyCreate, quoteUpdateMany, lifeUpdate, logAudit, requireApiRole, tenantConfigFindUnique, quoteFindFirst, premiumCreateMany, commissionCreate } = vi.hoisted(() => ({
  policyCreate: vi.fn(),
  // The bind now schedules premiums and accrues commission in the same
  // transaction; without these the tx mock throws and the route 500s.
  premiumCreateMany: vi.fn(),
  commissionCreate: vi.fn(),
  quoteUpdateMany: vi.fn(),
  lifeUpdate: vi.fn(),
  logAudit: vi.fn(),
  requireApiRole: vi.fn(),
  // Controllable so the IMS kill switch is exercised, not pinned open. The
  // REAL requireImsEnabled runs against this row.
  tenantConfigFindUnique: vi.fn(),
  quoteFindFirst: vi.fn(),
}))

function decimal(value: string) {
  return { toFixed: (dp: number) => Number(value).toFixed(dp) }
}

const QUOTE = {
  id: "quote-1",
  clientId: "client-1",
  productId: "product-1",
  advisorId: "advisor-1",
  status: "ACCEPTED",
  expiresAt: null,
  totalPremium: decimal("83.00"),
  totalSumAssured: decimal("20000.00"),
  convertedPolicyId: null,
  adviceRecord: { id: "advice-1" },
  product: { id: "product-1", type: "FUNERAL_COVER", commissionRate: 0.15 },
  effectiveDate: new Date("2026-08-16T00:00:00Z"),
  lives: [{ id: "life-1", lifeType: "MAIN_MEMBER", dateOfBirth: new Date("1990-05-10T00:00:00Z"), sumAssured: "20000.00" }],
}

/** The bind re-screens now, so the route mock must supply real terms. */
const RULES = [
  { id: "r1", lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "75", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "20000", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180", textValue: null, active: true },
]

const tx = {
  insurancePolicy: { create: policyCreate },
  premiumPayment: { createMany: premiumCreateMany },
  advisorCommission: { create: commissionCreate },
  insuredLife: { update: lifeUpdate },
  insuranceQuote: { updateMany: quoteUpdateMany },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    insuranceQuote: { findFirst: quoteFindFirst },
    insurancePolicy: { findUnique: async () => null, count: async () => 0 },
    insuranceEligibilityRule: { findMany: async () => RULES },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  quoteFindFirst.mockResolvedValue(QUOTE)
  policyCreate.mockResolvedValue({ id: "policy-1", policyNumber: "FUN-0001" })
  premiumCreateMany.mockResolvedValue({ count: 12 })
  commissionCreate.mockResolvedValue({ id: "comm-1" })
  quoteUpdateMany.mockResolvedValue({ count: 1 })
  lifeUpdate.mockResolvedValue({ id: "life-1" })
})

afterEach(() => {
  vi.clearAllMocks()
})

/** A token carrying the QUOTE's figures — the disclosure the client was shown. */
function validToken() {
  return signDraftToken({
    // The bind requires the token to name THIS quote.
    quoteId: "quote-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    advisorId: "advisor-1",
    type: "FUNERAL_COVER",
    sumAssured: 20000,
    premiumAmount: 83,
    productId: "product-1",
  })
}

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/insurance/quotes/quote-1/bind", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const ctx = { params: Promise.resolve({ id: "quote-1" }) }

// Cover may not be backdated, so a fixed calendar date goes stale the day it
// passes: these tests broke on 2026-09-01. A week from now is always valid.
const FUTURE_START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

describe("POST /api/insurance/quotes/[id]/bind", () => {
  it("IGNORES a premium and sum assured supplied in the request body", async () => {
    const { POST } = await import("./route")
    const res = await POST(
      request({
        draftToken: validToken(),
        startDate: FUTURE_START,
        // A caller trying to price their own policy. R1.00 for R10m of cover.
        premiumAmount: 1,
        sumAssured: 10_000_000,
        totalPremium: 1,
      }),
      ctx
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.premiumAmount).toBe("83.00")
    expect(body.sumAssured).toBe("20000.00")

    // And the persisted row carries the quote's figures, not the caller's.
    const created = policyCreate.mock.calls[0][0].data
    expect(created.premiumAmount).toBe("83.00")
    expect(created.sumAssured).toBe("20000.00")
    expect(created.premiumAmount).not.toBe(1)
    expect(created.sumAssured).not.toBe(10_000_000)
  })

  it("requires a draft token — no disclosure, no policy", async () => {
    const { POST } = await import("./route")
    const res = await POST(request({ startDate: FUTURE_START }), ctx)

    expect(res.status).toBe(422)
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it("refuses a token whose figures are not the quote's", async () => {
    const mismatched = signDraftToken({
      quoteId: "quote-1",
      tenantId: "tenant-1", clientId: "client-1", advisorId: "advisor-1",
      type: "FUNERAL_COVER", sumAssured: 20000, premiumAmount: 5, productId: "product-1",
    })
    const { POST } = await import("./route")
    const res = await POST(request({ draftToken: mismatched }), ctx)

    expect(res.status).toBe(422)
    expect((await res.json()).reason).toBe("TOKEN_MISMATCH")
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it("audits the bind with the figures as bound", async () => {
    const { POST } = await import("./route")
    await POST(request({ draftToken: validToken(), startDate: FUTURE_START }), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_BOUND",
        newValue: expect.objectContaining({ premiumAmount: "83.00", sumAssured: "20000.00" }),
      })
    )
  })
})
describe("POST bind — a date-only startDate naming today", () => {
  /**
   * Today's calendar date in SAST, derived WITHOUT the helper under test —
   * an assertion built from the same source it checks cannot fail. `en-CA`
   * formats as `YYYY-MM-DD`.
   */
  function todayInSast() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" })
  }

  // The whole point of the fix, at the HTTP boundary. `"2026-08-17"` used to
  // parse to midnight UTC — an instant in the past — so `bind.ts` refused it as
  // backdated cover and staff could not bind a policy starting today. If the
  // route stops routing this field through `parseInsuranceDateInput`, this
  // returns 422 and the test fails.
  it("binds rather than refusing the day as backdated", async () => {
    const { POST } = await import("./route")
    const res = await POST(request({ draftToken: validToken(), startDate: todayInSast() }), ctx)

    expect(res.status).toBe(201)
    expect(policyCreate).toHaveBeenCalled()
  })

  it("binds when startDate is omitted entirely", async () => {
    // `bindQuote` refuses `startDate < now`. The route stamps both from ONE
    // instant; if it ever again stamps them separately, this is the call that
    // races — the default start date is judged against a `now` read after it.
    const { POST } = await import("./route")
    const res = await POST(request({ draftToken: validToken() }), ctx)

    expect(res.status).toBe(201)
    expect(policyCreate).toHaveBeenCalled()
  })

  it("still refuses a date-only startDate naming a past day", async () => {
    // The fix must not make backdating unrefusable: only TODAY resolves to now.
    const { POST } = await import("./route")
    const res = await POST(request({ draftToken: validToken(), startDate: "2026-08-16" }), ctx)

    expect(res.status).toBe(422)
    expect((await res.json()).reason).toBe("START_DATE_OUT_OF_RANGE")
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it("refuses a startDate that is not a usable date", async () => {
    const { POST } = await import("./route")
    const res = await POST(request({ draftToken: validToken(), startDate: "2026-02-30" }), ctx)

    expect(res.status).toBe(422)
    expect(policyCreate).not.toHaveBeenCalled()
  })
})

describe("POST bind — the guards, exercised in both directions", () => {
  it("requires INSURANCE_OFFICER", async () => {
    const { POST } = await import("./route")
    await POST(request({ draftToken: validToken() }), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("INSURANCE_OFFICER")
  })

  it("returns the role guard's refusal, binds nothing and audits nothing", async () => {
    requireApiRole.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })
    const { POST } = await import("./route")

    const res = await POST(request({ draftToken: validToken() }), ctx)

    expect(res.status).toBe(403)
    expect(quoteFindFirst).not.toHaveBeenCalled()
    expect(policyCreate).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("is 404 with the IMS feature flag off, and binds nothing", async () => {
    // The real requireImsEnabled runs; only the TenantConfig row is stubbed.
    tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: false })
    const { POST } = await import("./route")

    const res = await POST(request({ draftToken: validToken() }), ctx)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
    expect(policyCreate).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("stays closed when the flag lookup THROWS, rather than failing open", async () => {
    tenantConfigFindUnique.mockRejectedValue(new Error("db unreachable"))
    const { POST } = await import("./route")

    const res = await POST(request({ draftToken: validToken() }), ctx)

    expect(res.status).toBe(404)
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it("audits a refused bind", async () => {
    quoteFindFirst.mockResolvedValue({ ...QUOTE, adviceRecord: null })
    const { POST } = await import("./route")

    const res = await POST(request({ draftToken: validToken() }), ctx)

    expect(res.status).toBe(409)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_BIND_REFUSED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        newValue: expect.objectContaining({ reason: "NOT_BINDABLE" }),
      })
    )
  })

  it("does not audit a bind refused for a missing token — nothing was attempted", async () => {
    const { POST } = await import("./route")
    const res = await POST(request({}), ctx)

    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
