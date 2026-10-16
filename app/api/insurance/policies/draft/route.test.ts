// app/api/insurance/policies/draft/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { POST } from "./route"

const { findUniqueClient, findUniqueAdvisor, findUniqueProduct, findManyRateTable, findManyRule, getTenantFromRequest, logAudit, writeFile, mkdir } = vi.hoisted(() => ({
  findUniqueClient: vi.fn(),
  findUniqueAdvisor: vi.fn(),
  findUniqueProduct: vi.fn(),
  // Phase 2: the rating gate reads the product's ACTIVE rate card and its
  // eligibility terms before any PDF is rendered.
  findManyRateTable: vi.fn(),
  findManyRule: vi.fn(),
  getTenantFromRequest: vi.fn(),
  logAudit: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

const lenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity-response", () => ({
  lenderIdentityOrRefusal: (...args: unknown[]) => lenderIdentityMock(...args),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    client: { findUnique: findUniqueClient },
    user: { findUnique: findUniqueAdvisor },
    insuranceProduct: { findUnique: findUniqueProduct },
    insuranceRateTable: { findMany: findManyRateTable },
    insuranceEligibilityRule: { findMany: findManyRule },
  },
}))
// TenantContext (lib/tenant.ts) requires name: string, so the mock includes it.
// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), getTenantFromRequest, withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "t1", name: "Test Tenant" }) }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn().mockResolvedValue({ user: { id: "u1", email: "advisor@example.com" } }) }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))
// The route writes through lib/storage (encrypted at rest); the mock records what it was asked to write.
vi.mock("@/lib/storage", () => ({ saveFileAt: (rel: string, buf: Buffer) => writeFile(rel, buf) }))

// ── Rating-gate fixture ──────────────────────────────────────────────────────
//
// The gate prices the client as a single MAIN_MEMBER life against the ACTIVE
// card, so the fixture has to be a card that can actually price them.
//
// NON-UNIFORM on purpose: four life types at four different premiums. The
// R420.00 assertion below is only reachable by matching the MAIN_MEMBER band —
// with a flat card every band would produce 420 and the assertion would hold
// however badly the matching was broken.
//
// All four life types carry a band because `canSellProduct` refuses a product
// whose rules screen a life type its card cannot price, and the ALL_LIVES rules
// below make all four screenable.
const BANDS = [
  { id: "b-mm", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: "50000.00", premiumAmount: "420.00" },
  { id: "b-sp", lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "50000.00", premiumAmount: "310.00" },
  { id: "b-ch", lifeType: "CHILD", minAge: 0, maxAge: 21, sumAssured: "50000.00", premiumAmount: "75.50" },
  { id: "b-ef", lifeType: "EXTENDED_FAMILY", minAge: 18, maxAge: 75, sumAssured: "50000.00", premiumAmount: "515.25" },
]

const ACTIVE_TABLE = {
  id: "rt-1", version: 1, name: "2026 funeral", basis: "AGE_BANDED",
  effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null, insurerId: "ins-1",
  bands: BANDS,
}

/** The four MANDATORY rule types, so the product screens as sellable. */
const RULES = [
  { id: "r1", lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "75", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "50000", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180", textValue: null, active: true },
]

/** A client the card can price: 41 in 2026, inside the 18-65 MAIN_MEMBER band. */
const RATEABLE_CLIENT = {
  id: "c1", firstName: "Thandeka", lastName: "Mokoena", idNumber: "8503015000083",
  dateOfBirth: new Date("1985-03-01T00:00:00Z"),
}

/** Put the product in a state where a R420.00 draft for R50 000 of cover passes. */
function rateCardConfigured() {
  findManyRateTable.mockResolvedValue([ACTIVE_TABLE])
  findManyRule.mockResolvedValue(RULES)
}

afterEach(() => { vi.clearAllMocks() })
beforeEach(() => {
  lenderIdentityMock.mockImplementation(async () => {
    const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
    return { identity: parseLenderIdentity(VALID_LENDER_COLUMNS) }
  })
})

describe("POST /api/insurance/policies/draft", () => {
  it("refuses with 409 and writes no PDF without a configured lender identity", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    rateCardConfigured()
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "FUNERAL_COVER", name: "Family Funeral Cover" })
    const { NextResponse } = await import("next/server")
    lenderIdentityMock.mockResolvedValueOnce({ refusal: NextResponse.json({ code: "LENDER_IDENTITY_NOT_CONFIGURED" }, { status: 409 }) })

    const res = await POST(new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify({ clientId: "c1", advisorId: "u1", productId: "p1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420 }),
      headers: { "content-type": "application/json" },
    }))
    expect(res.status).toBe(409)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("returns 201 with pdfUrl + draftToken for a valid request", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    rateCardConfigured()
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "FUNERAL_COVER", name: "Family Funeral Cover" })

    const req = new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify({ clientId: "c1", advisorId: "u1", productId: "p1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420 }),
      headers: { "content-type": "application/json" },
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.pdfUrl).toMatch(/^\/api\/insurance\/disclosures\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(body.draftToken).toEqual(body.pdfUrl.split("/").pop())
    expect(writeFile).toHaveBeenCalledOnce()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "INSURANCE_FAIS_DISCLOSURE_RENDERED" }))
  })

  // §2a.2: no FAIS disclosure, and so no policy, without an FSP number.
  it("refuses with 409 and the Settings hint when the lender holds no FSP number", async () => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    rateCardConfigured()
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "FUNERAL_COVER", name: "Family Funeral Cover" })
    lenderIdentityMock.mockImplementationOnce(async () => {
      const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
      const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
      return { identity: parseLenderIdentity({ ...VALID_LENDER_COLUMNS, fscaNumber: null }) }
    })
    const res = await POST(new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify({ clientId: "c1", advisorId: "u1", productId: "p1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420 }),
      headers: { "content-type": "application/json" },
    }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "LENDER_FSP_NOT_CONFIGURED", error: expect.stringMatching(/Settings → Lender identity/) })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("returns 404 when client is in a different tenant", async () => {
    findUniqueClient.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify({ clientId: "c1", advisorId: "u1", productId: "p1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420 }),
      headers: { "content-type": "application/json" },
    })
    const res = await POST(req)
    expect(res.status).toBe(404)
  })
})

describe("POST /api/insurance/policies/draft — the rating gate", () => {
  function request(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  }

  const FUNERAL = { clientId: "c1", advisorId: "u1", productId: "p1", type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420 }

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "FUNERAL_COVER", name: "Family Funeral Cover" })
    rateCardConfigured()
  })

  it("refuses a premium the rate card does not produce, and NAMES the derived figure", async () => {
    const res = await POST(request({ ...FUNERAL, premiumAmount: 300 }))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reason).toBe("PREMIUM_MISMATCH")
    // The operator is told what the figure SHOULD be, not merely that theirs is wrong.
    expect(body.derivedPremium).toBe("420.00")
    expect(body.error).toContain("420.00")
  })

  it("does NOT render or write a disclosure PDF when rating refuses", async () => {
    // The reason the gate lives on this route rather than on the bind: a
    // client-facing regulatory document must never exist for a price the
    // insurer's card does not support.
    await POST(request({ ...FUNERAL, premiumAmount: 300 }))

    expect(writeFile).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it("audits the refusal", async () => {
    await POST(request({ ...FUNERAL, premiumAmount: 300 }))

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_DRAFT_RATING_REJECTED",
        newValue: expect.objectContaining({ reason: "PREMIUM_MISMATCH", requestedPremium: 300, derivedPremium: "420.00" }),
      })
    )
    // And NOT the success audit.
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_FAIS_DISCLOSURE_RENDERED" })
    )
  })

  it("refuses a rated type with no productId, because nothing can price it", async () => {
    const { productId: _omitted, ...noProduct } = FUNERAL
    const res = await POST(request(noProduct))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("PRODUCT_REQUIRED")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("refuses a product with no ACTIVE rate table — canSellProduct is a GATE", async () => {
    findManyRateTable.mockResolvedValue([])
    const res = await POST(request(FUNERAL))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("PRODUCT_NOT_SELLABLE")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("refuses a client with no date of birth rather than guessing an age", async () => {
    findUniqueClient.mockResolvedValue({ ...RATEABLE_CLIENT, dateOfBirth: null })
    const res = await POST(request(FUNERAL))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NO_DATE_OF_BIRTH")
  })

  it("screens LIFE_INSURANCE too", async () => {
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "LIFE_INSURANCE", name: "Life Cover" })
    const res = await POST(request({ ...FUNERAL, type: "LIFE_INSURANCE", premiumAmount: 999 }))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("PREMIUM_MISMATCH")
  })

  it("accepts the premium the card DOES produce", async () => {
    const res = await POST(request(FUNERAL))
    expect(res.status).toBe(201)
    expect(writeFile).toHaveBeenCalledOnce()
  })
})

describe("POST /api/insurance/policies/draft — credit life and short-term are UNTOUCHED", () => {
  function request(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  }

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    // NO rate table and NO rules anywhere. These types have no rate cards —
    // credit life is priced off the loan principal and bound at disbursement.
    findManyRateTable.mockResolvedValue([])
    findManyRule.mockResolvedValue([])
  })

  it("a CREDIT_LIFE draft still succeeds with NO rate table present", async () => {
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "CREDIT_LIFE", name: "Credit Life" })
    const res = await POST(request({ clientId: "c1", advisorId: "u1", productId: "p1", type: "CREDIT_LIFE", sumAssured: 20000, premiumAmount: 88 }))

    expect(res.status).toBe(201)
    expect(writeFile).toHaveBeenCalledOnce()
    // The rate card was never consulted for this type.
    expect(findManyRateTable).not.toHaveBeenCalled()
  })

  it("a SHORT_TERM_MOTOR draft still succeeds with NO rate table present", async () => {
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "SHORT_TERM_MOTOR", name: "Motor" })
    const res = await POST(request({ clientId: "c1", advisorId: "u1", productId: "p1", type: "SHORT_TERM_MOTOR", sumAssured: 150000, premiumAmount: 640 }))

    expect(res.status).toBe(201)
    expect(findManyRateTable).not.toHaveBeenCalled()
  })

  it("a credit life draft succeeds even with no productId at all", async () => {
    const res = await POST(request({ clientId: "c1", advisorId: "u1", type: "CREDIT_LIFE", sumAssured: 20000, premiumAmount: 88 }))
    expect(res.status).toBe(201)
  })
})

describe("POST /api/insurance/policies/draft — the gate cannot be bypassed by `type`", () => {
  function request(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/insurance/policies/draft", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  }

  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
    findUniqueClient.mockResolvedValue(RATEABLE_CLIENT)
    findUniqueAdvisor.mockResolvedValue({ id: "u1", name: "Bongani Zulu" })
    // The product is FUNERAL_COVER — a RATED type.
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "FUNERAL_COVER", name: "Family Funeral Cover" })
    rateCardConfigured()
  })

  it("refuses a body type that disagrees with the product's type", async () => {
    // THE BYPASS: claim CREDIT_LIFE against a FUNERAL_COVER product and
    // requiresRating() went false, skipping the gate entirely and issuing a
    // client-facing disclosure at a premium no rate card produced.
    const res = await POST(request({
      clientId: "c1", advisorId: "u1", productId: "p1",
      type: "CREDIT_LIFE", sumAssured: 50000, premiumAmount: 0.01,
    }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/does not match the product/i)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("rates against the PRODUCT's type, so a matching body type is still screened", async () => {
    const res = await POST(request({
      clientId: "c1", advisorId: "u1", productId: "p1",
      type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 1,
    }))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("PREMIUM_MISMATCH")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("refuses a type that is not a real InsurancePolicyType", async () => {
    const res = await POST(request({
      clientId: "c1", advisorId: "u1", productId: "p1",
      type: "NOT_A_TYPE", sumAssured: 50000, premiumAmount: 420,
    }))
    expect(res.status).toBe(422)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("reaches PRODUCT_REQUIRED for a rated type with no product", async () => {
    // The gate's own refusal could never fire, because the gate was skipped
    // before it could be consulted.
    const res = await POST(request({
      clientId: "c1", advisorId: "u1",
      type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420,
    }))

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("PRODUCT_REQUIRED")
  })

  it("refuses a negative premium on the NON-rated branch too", async () => {
    // The non-rated branch did no numeric validation at all.
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "CREDIT_LIFE", name: "Credit Life" })
    const res = await POST(request({
      clientId: "c1", advisorId: "u1", productId: "p1",
      type: "CREDIT_LIFE", sumAssured: 20000, premiumAmount: -50,
    }))

    expect(res.status).toBe(422)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("refuses a zero premium on the non-rated branch", async () => {
    findUniqueProduct.mockResolvedValue({ id: "p1", type: "CREDIT_LIFE", name: "Credit Life" })
    const res = await POST(request({
      clientId: "c1", advisorId: "u1", productId: "p1",
      type: "CREDIT_LIFE", sumAssured: 20000, premiumAmount: 0,
    }))
    expect(res.status).toBe(422)
  })
})
