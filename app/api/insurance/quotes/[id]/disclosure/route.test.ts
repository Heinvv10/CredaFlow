// app/api/insurance/quotes/[id]/disclosure/route.test.ts
//
// The issuing route's guards. Everything here is about ONE property: a
// client-facing FAIS document must not exist for cover that cannot be sold.
// Each refusal therefore asserts that no PDF was rendered or written, not
// merely that a 4xx came back — the artefact is the harm, not the status code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const {
  requireApiRole,
  findFirstQuote,
  updateManyQuote,
  tenantConfigFindUnique,
  logAudit,
  writeFile,
  mkdir,
  findManyRules,
  generatePdf,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findFirstQuote: vi.fn(),
  updateManyQuote: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  findManyRules: vi.fn(),
  // G3: the RENDER itself is now observable, so "no artefact" can assert the
  // document was never produced rather than only that it was never written.
  generatePdf: vi.fn(),
}))

const lenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity", () => ({
  findLenderIdentity: (...args: unknown[]) => lenderIdentityMock(...args),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    insuranceQuote: { findFirst: findFirstQuote, updateMany: updateManyQuote },
    insuranceEligibilityRule: { findMany: findManyRules },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))
// The route writes through lib/storage (encrypted at rest); the mock records what it was asked to write.
vi.mock("@/lib/storage", () => ({ saveFileAt: (rel: string, buf: Buffer) => writeFile(rel, buf) }))
vi.mock("@/lib/pdf/faisDisclosure", () => ({ generateFaisDisclosurePdf: generatePdf }))

import path from "node:path"
import { POST } from "./route"

function decimal(value: string) {
  return { toFixed: (dp: number) => Number(value).toFixed(dp) }
}

const QUOTE = {
  id: "quote-1",
  status: "ACCEPTED",
  quoteNumber: "QTE-1",
  clientId: "client-1",
  productId: "product-1",
  advisorId: "advisor-1",
  totalPremium: decimal("83.00"),
  totalSumAssured: decimal("20000.00"),
  expiresAt: null as Date | null,
  disclosuresIssued: 0,
  convertedPolicyId: null as string | null,
  effectiveDate: new Date("2026-08-16T00:00:00Z"),
  client: { firstName: "Thandi", lastName: "Nkosi", idNumber: "9005105000087" },
  product: { type: "FUNERAL_COVER", name: "Family Funeral" },
  advisor: { name: "Bongani Zulu", email: "adv@acme-lending.example" },
  lives: [
    { firstName: "Thandi", lastName: "Nkosi", lifeType: "MAIN_MEMBER", relationship: "SELF", sumAssured: decimal("10000.00"), premiumAmount: decimal("45.00"), dateOfBirth: new Date("1990-05-10T00:00:00Z") },
    { firstName: "Sipho", lastName: "Nkosi", lifeType: "SPOUSE", relationship: "SPOUSE", sumAssured: decimal("10000.00"), premiumAmount: decimal("38.00"), dateOfBirth: new Date("1988-03-01T00:00:00Z") },
  ],
}

/** The four MANDATORY rule types, so a clean quote screens as acceptable. */
const RULES = [
  { id: "r1", lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18", textValue: null, active: true },
  { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "75", textValue: null, active: true },
  { id: "r3", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "10000", textValue: null, active: true },
  { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180", textValue: null, active: true },
]

const req = () => new NextRequest("http://localhost/api/insurance/quotes/quote-1/disclosure", {
  method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" },
})
const ctx = { params: Promise.resolve({ id: "quote-1" }) }

/**
 * No PDF was RENDERED, written, or its directory created.
 *
 * The generator is asserted directly. It previously was not: the helper claimed
 * "rendered or written" while checking only `writeFile` and `mkdir`, and the
 * claim held transitively only because `mkdir` happens to precede the render.
 * Move a guard between render and write and every test here would stay green
 * with the document already produced — a comment overstating its guarantee.
 */
function assertNoArtefact() {
  expect(generatePdf).not.toHaveBeenCalled()
  expect(writeFile).not.toHaveBeenCalled()
  expect(mkdir).not.toHaveBeenCalled()
}

beforeEach(() => {
  lenderIdentityMock.mockImplementation(async () => {
    const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
    return parseLenderIdentity(VALID_LENDER_COLUMNS)
  })
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
  requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  findFirstQuote.mockResolvedValue(QUOTE)
  updateManyQuote.mockResolvedValue({ count: 1 })
  findManyRules.mockResolvedValue(RULES)
  generatePdf.mockResolvedValue(Buffer.from("%PDF-1.4 test"))
})

afterEach(() => { vi.clearAllMocks() })

describe("POST quote disclosure — guards", () => {
  it("requires INSURANCE_OFFICER", async () => {
    await POST(req(), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("INSURANCE_OFFICER")
  })

  it("returns the role guard's refusal and issues nothing", async () => {
    requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(403)
    expect(findFirstQuote).not.toHaveBeenCalled()
    assertNoArtefact()
    // Nothing below the ROLE guard runs, so there is no tenant context to
    // audit against — distinct from the refusals inside the handler, which do.
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("is 404 with the IMS flag off", async () => {
    tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: false })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    assertNoArtefact()
  })

  it("scopes the quote lookup to the caller's tenant", async () => {
    await POST(req(), ctx)
    expect(findFirstQuote).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote-1", tenantId: "tenant-1" } })
    )
  })

  it("is 404 for another tenant's quote", async () => {
    findFirstQuote.mockResolvedValue(null)
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    assertNoArtefact()
  })
})

describe("POST quote disclosure — no document for cover that cannot be sold", () => {
  it("refuses a DRAFT quote", async () => {
    // A DRAFT failed rating or screening. Disclosing it would put a price in
    // front of a client that the insurer's own terms refuse.
    findFirstQuote.mockResolvedValue({ ...QUOTE, status: "DRAFT" })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_DISCLOSABLE")
    assertNoArtefact()
  })

  it("refuses a REJECTED or CONVERTED quote", async () => {
    for (const status of ["REJECTED", "CONVERTED", "EXPIRED"]) {
      vi.clearAllMocks()
      requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "o@n.co.za" } })
      tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
      findFirstQuote.mockResolvedValue({ ...QUOTE, status })

      const res = await POST(req(), ctx)

      expect(res.status).toBe(409)
      assertNoArtefact()
    }
  })

  it("refuses a quote carrying no premium", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, totalPremium: null, totalSumAssured: null })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_PRICED")
    assertNoArtefact()
  })

  it("refuses an EXPIRED quote before rendering anything", async () => {
    // The bind refuses an expired quote too. Without this check the failure
    // lands in the worst order: the document is rendered and signed, and only
    // afterwards is the bind refused.
    findFirstQuote.mockResolvedValue({ ...QUOTE, expiresAt: new Date("2020-01-01T00:00:00Z") })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("QUOTE_EXPIRED")
    assertNoArtefact()
    // AUDITED. This assertion used to require the opposite — that a refusal
    // wrote nothing — which made repeated attempts to obtain a disclosure for
    // an expired quote invisible to an auditor asking whether the gate fired.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_DISCLOSURE_REFUSED",
        newValue: expect.objectContaining({ reason: "QUOTE_EXPIRED" }),
      })
    )
  })

  // The disclosure names the FSP: the tenant's own legal name and licence
  // number, and nothing is reserved or rendered without them.
  it("prints the tenant's legal name and FSP number", async () => {
    await POST(req(), ctx)
    expect(generatePdf).toHaveBeenCalledWith(expect.objectContaining({
      lender: expect.objectContaining({ legalName: "Acme Lending (Pty) Ltd", fspNumber: "12345" }),
    }))
  })

  it("refuses with 409, audits it, reserves nothing and renders nothing without a configured lender identity", async () => {
    lenderIdentityMock.mockResolvedValueOnce(null)
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("LENDER_IDENTITY_NOT_CONFIGURED")
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).toContain("LENDER_IDENTITY_NOT_CONFIGURED")
    expect(updateManyQuote).not.toHaveBeenCalled()
    assertNoArtefact()
  })

  it("issues for a quote still inside its window", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, expiresAt: new Date("2099-01-01T00:00:00Z") })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(201)
  })

  it("refuses a quote covering no lives", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, lives: [] })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NO_LIVES")
    assertNoArtefact()
  })
})

describe("POST quote disclosure — the token carries what the bind compares", () => {
  it("returns a token naming the quote, its totals and its identity", async () => {
    const res = await POST(req(), ctx)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.draftToken).toBeTruthy()
    expect(body.pdfUrl).toBe(`/api/insurance/disclosures/${body.draftToken}`)
    expect(body.totalPremium).toBe("83.00")
    expect(body.totalSumAssured).toBe("20000.00")
    expect(body.lives).toBe(2)

    // Decode the payload and check every field the bind compares.
    const payload = JSON.parse(Buffer.from(body.draftToken.split(".")[0], "base64url").toString("utf8"))
    expect(payload).toMatchObject({
      quoteId: "quote-1",
      tenantId: "tenant-1",
      clientId: "client-1",
      productId: "product-1",
      type: "FUNERAL_COVER",
      premiumAmount: 83,
      sumAssured: 20000,
    })
  })

  it("carries the quote's TOTALS, not one life's premium", async () => {
    // The seam that broke the phase: the bind requires the family total, and
    // the legacy issuer could only ever produce a single life's figure.
    const res = await POST(req(), ctx)
    const body = await res.json()
    const payload = JSON.parse(Buffer.from(body.draftToken.split(".")[0], "base64url").toString("utf8"))

    expect(payload.premiumAmount).toBe(83)
    expect(payload.premiumAmount).not.toBe(45)
  })

  it("audits the issue with the hash of the document presented", async () => {
    await POST(req(), ctx)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_DISCLOSURE_ISSUED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        newValue: expect.objectContaining({
          pdfSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          totalPremium: "83.00",
          lives: 2,
        }),
      })
    )
  })

  it("writes the PDF under a fixed-length hashed filename", async () => {
    // The token exceeds the 255-byte filename limit once it carries a quoteId,
    // so the file is named by sha256(token) rather than by the token.
    await POST(req(), ctx)

    expect(writeFile).toHaveBeenCalledOnce()
    const written = String(writeFile.mock.calls[0][0])
    expect(written).toMatch(/\/[0-9a-f]{64}\.pdf$/)
    // The 255-byte limit is on the FILENAME COMPONENT, not the whole path.
    // Measuring the absolute path passed with a 300-character basename and
    // could fail spuriously under a deep checkout.
    expect(path.basename(written).length).toBeLessThanOrEqual(255)
  })
})

describe("POST quote disclosure — bounded issuance, audited refusals", () => {
  it("audits every in-handler refusal", async () => {
    for (const [mutate, reason] of [
      [{ status: "DRAFT" }, "NOT_DISCLOSABLE"],
      [{ totalPremium: null, totalSumAssured: null }, "NOT_PRICED"],
      [{ lives: [] }, "NO_LIVES"],
    ] as const) {
      vi.clearAllMocks()
      requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "o@n.co.za" } })
      tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
      updateManyQuote.mockResolvedValue({ count: 1 })
      findFirstQuote.mockResolvedValue({ ...QUOTE, ...mutate })

      await POST(req(), ctx)

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "INSURANCE_QUOTE_DISCLOSURE_REFUSED",
          entityId: "quote-1",
          newValue: expect.objectContaining({ reason }),
        })
      )
    }
  })

  it("refuses once the quote has hit its disclosure cap", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, disclosuresIssued: 10 })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(429)
    expect((await res.json()).reason).toBe("TOO_MANY_DISCLOSURES")
    assertNoArtefact()
    // The reservation is never attempted once the friendly check has refused.
    expect(updateManyQuote).not.toHaveBeenCalled()
  })

  it("RESERVES the slot atomically before rendering anything", async () => {
    await POST(req(), ctx)

    expect(updateManyQuote).toHaveBeenCalledWith({
      where: {
        id: "quote-1",
        tenantId: "tenant-1",
        status: "ACCEPTED",
        disclosuresIssued: { lt: 10 },
        OR: [{ expiresAt: null }, { expiresAt: expect.objectContaining({ gt: expect.any(Date) }) }],
      },
      data: { disclosuresIssued: { increment: 1 } },
    })
    // Reserved BEFORE the write, so a crash burns a slot rather than leaving a
    // file on disk no counter knows about.
    expect(updateManyQuote.mock.invocationCallOrder[0])
      .toBeLessThan(writeFile.mock.invocationCallOrder[0])
  })

  it("refuses when the reservation is lost to a concurrent change", async () => {
    // The quote expired, changed status, or hit the cap while this request was
    // in flight — the window between reading expiresAt and writing the PDF.
    updateManyQuote.mockResolvedValue({ count: 0 })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("RESERVATION_LOST")
    assertNoArtefact()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ reason: "RESERVATION_LOST" }) })
    )
  })
})
describe("POST quote disclosure — screened against the insurer's CURRENT terms", () => {
  it("refuses lives the terms now reject, even though the quote passed when created", async () => {
    // The Phase 2 config UI exists so an operator can change these terms. The
    // quote's stored eligibilityResult records what was true at creation; it is
    // not evidence about today. Without this the FAIS document was rendered,
    // written and signed, and only the bind refused — after the conversation.
    findManyRules.mockResolvedValue([
      ...RULES.filter((r) => r.ruleType !== "MAX_ENTRY_AGE"),
      { id: "r2", lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "30", textValue: null, active: true },
    ])

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_ELIGIBLE")
    assertNoArtefact()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ reason: "NOT_ELIGIBLE" }) })
    )
  })

  it("refuses when a mandatory term is not configured at all", async () => {
    findManyRules.mockResolvedValue([])
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_ELIGIBLE")
    assertNoArtefact()
  })

  it("refuses an unusable WAITING_PERIOD_DAYS rather than disclosing immediate cover", async () => {
    // evaluate() checks the term resolves and carries a value but never parses
    // it, so this is the only guard on that path here, as at the bind.
    findManyRules.mockResolvedValue([
      ...RULES.filter((r) => r.ruleType !== "WAITING_PERIOD_DAYS"),
      { id: "r4", lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "not-a-number", textValue: null, active: true },
    ])

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("WAITING_PERIOD_INVALID")
    assertNoArtefact()
  })

  it("refuses a quote already bound to a policy", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, convertedPolicyId: "policy-1" })

    const res = await POST(req(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("ALREADY_CONVERTED")
    assertNoArtefact()
  })
})

describe("POST quote disclosure — every permitted status is exercised", () => {
  // Negative cases alone let DISCLOSABLE be NARROWED to ["ACCEPTED"] with the
  // whole suite green while the ordinary sales flow became impossible. A
  // list-valued guard needs mutation in both directions, so each permitted
  // entry gets its own positive case.
  for (const status of ["QUOTED", "ADVICE_RECORDED", "SUBMITTED_TO_INSURER", "ACCEPTED"]) {
    it(`issues for a ${status} quote`, async () => {
      findFirstQuote.mockResolvedValue({ ...QUOTE, status })

      const res = await POST(req(), ctx)

      expect(res.status).toBe(201)
      expect(generatePdf).toHaveBeenCalledOnce()
    })
  }
})

describe("POST quote disclosure — the PDF renders an unrated life honestly", () => {
  it("passes a null premium through rather than inventing a figure", async () => {
    findFirstQuote.mockResolvedValue({
      ...QUOTE,
      lives: [{ ...QUOTE.lives[0], premiumAmount: null }],
    })

    await POST(req(), ctx)

    const rendered = generatePdf.mock.calls[0][0] as { lives: { premiumAmount: number | null }[] }
    expect(rendered.lives[0].premiumAmount).toBeNull()
  })
})
