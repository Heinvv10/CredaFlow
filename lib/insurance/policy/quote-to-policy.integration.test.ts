/**
 * THE TEST WHOSE ABSENCE HID THE PHASE'S WORST DEFECT.
 *
 *   RUN_IMS_BIND_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/policy/quote-to-policy.integration.test.ts
 *
 * Every layer of this phase passed its own tests while the SEAM between them
 * could not work at all: a multi-life quote could never obtain a disclosure
 * token the bind would accept. `bind.integration.test.ts` did not catch it
 * because it MINTS ITS OWN TOKEN with `signDraftToken`, proving the bind works
 * *given* a token and never asking whether one is obtainable.
 *
 * So the rule this file exists to enforce: **no token is constructed here.**
 * The only token used is the one an issuing route actually returned. If the
 * system cannot issue a usable token, this test fails — which is the whole
 * point.
 */
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { bindQuote } from "./bind"

const RUN = process.env.RUN_IMS_BIND_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 12)

// Client.idNumber is globally @unique, so each seeded fixture needs its own.
// Deriving it from the label collided: two labels sharing a five-character
// prefix produced the same number and the second seed died on the constraint.
let idSeq = 0
const idRun = String(Date.now()).slice(-7)
function nextIdNumber(): string {
  idSeq += 1
  // Run-unique as well as fixture-unique: a bare counter restarts at 1 on the
  // next run and collides with rows the previous run left behind, so the suite
  // passed once and then failed against its own leftovers.
  return `${idRun}${String(idSeq).padStart(6, "0")}`
}

const EFFECTIVE = new Date("2026-08-16T00:00:00Z")
const START = new Date("2026-09-01T00:00:00Z")
const NOW = new Date("2026-08-20T00:00:00Z")

const store = prisma as unknown as PrismaClient

// The routes resolve their tenant from the request; pin it to the seeded one.
let seededTenantId = ""
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: seededTenantId, name: "IT Tenant" }),
}))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({ user: { id: "it-user", email: "officer@it.test" } }),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

interface Fixture {
  tenantId: string
  clientId: string
  advisorId: string
  productId: string
  quoteId: string
  totalPremium: string
  totalSumAssured: string
}

/**
 * A REAL multi-life family quote: main member + spouse, each priced from its
 * own band, totalling a figure that is the sum of two different premiums.
 * That sum is what the bind requires the token to carry.
 */
async function seedFamilyQuote(label: string): Promise<Fixture> {
  const suffix = `${label}_${token}`
  const tenantId = `t_${suffix}`

  await prisma.tenant.create({ data: { id: tenantId, name: `IT ${suffix}`, slug: `it-${suffix}` } })
  // featureIms ON — requireImsEnabled reads the LIVE TenantConfig row, and
  // without it every insurance route 404s before any logic runs. The lender
  // identity too: the disclosure route refuses (409) to issue a FAIS
  // disclosure for a tenant whose identity is not configured.
  await prisma.tenantConfig.create({ data: { tenantId, featureIms: true, ...VALID_LENDER_COLUMNS } })

  const advisor = await prisma.user.create({
    data: {
      tenantId, email: `adv_${suffix}@it.test`, name: "Advisor",
      password: "x", role: "INSURANCE_OFFICER",
    },
  })

  const client = await prisma.client.create({
    data: {
      tenantId, firstName: "Thandi", lastName: "Nkosi",
      idNumber: nextIdNumber(),
      email: `${suffix}@it.test`, phone: "0820000000",
      dateOfBirth: new Date("1990-05-10T00:00:00Z"),
    },
  })

  const product = await prisma.insuranceProduct.create({
    data: {
      tenantId, code: `FUN_${suffix}`.slice(0, 20), name: "Family Funeral",
      type: "FUNERAL_COVER", premiumAmount: "0.00", sumAssured: "0.00", commissionRate: "0.1500",
    },
  })

  // Four life types so canSellProduct passes; four DIFFERENT premiums so the
  // total can only be right if each life matched its own band.
  const rateTable = await prisma.insuranceRateTable.create({
    data: {
      tenantId, productId: product.id, version: 1, name: "2026 card",
      status: "ACTIVE", basis: "AGE_BANDED", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      bands: {
        create: [
          { lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "45.00" },
          { lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "38.00" },
          { lifeType: "CHILD", minAge: 0, maxAge: 21, sumAssured: "10000.00", premiumAmount: "12.00" },
          { lifeType: "EXTENDED_FAMILY", minAge: 18, maxAge: 80, sumAssured: "10000.00", premiumAmount: "60.00" },
        ],
      },
    },
    include: { bands: true },
  })

  await prisma.insuranceEligibilityRule.createMany({
    data: [
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "0" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "80" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "10000" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180" },
    ],
  })

  const band = (lt: string) => rateTable.bands.find((b) => b.lifeType === lt)!.id

  const quote = await prisma.insuranceQuote.create({
    data: {
      tenantId, clientId: client.id, productId: product.id, advisorId: advisor.id,
      quoteNumber: `QTE_${suffix}`, status: "ACCEPTED", rateTableId: rateTable.id,
      // 45.00 + 38.00 across 10000 + 10000.
      totalPremium: "83.00", totalSumAssured: "20000.00",
      effectiveDate: EFFECTIVE, eligibilityResult: { pass: true, failures: [] },
      lives: {
        create: [
          {
            clientId: client.id, firstName: "Thandi", lastName: "Nkosi",
            dateOfBirth: new Date("1990-05-10T00:00:00Z"), relationship: "SELF",
            lifeType: "MAIN_MEMBER", sumAssured: "10000.00", premiumAmount: "45.00",
            rateBandId: band("MAIN_MEMBER"),
          },
          {
            firstName: "Sipho", lastName: "Nkosi",
            dateOfBirth: new Date("1988-03-01T00:00:00Z"), relationship: "SPOUSE",
            lifeType: "SPOUSE", sumAssured: "10000.00", premiumAmount: "38.00",
            rateBandId: band("SPOUSE"),
          },
        ],
      },
      adviceRecord: {
        create: {
          tenantId, needsAnalysis: "Sole earner, dependants.",
          productsConsidered: [{ code: "FUN-10K" }], recommendation: "FUN-10K",
          clientDecision: "ACCEPTED_RECOMMENDATION", contentHash: "0".repeat(64),
        },
      },
    },
  })

  return {
    tenantId, clientId: client.id, advisorId: advisor.id, productId: product.id,
    quoteId: quote.id, totalPremium: "83.00", totalSumAssured: "20000.00",
  }
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "it-secret-do-not-use-in-prod-1234567890"
})

suite("quote -> disclosure -> bind, end to end, with NO hand-minted token", () => {
  it("issues a disclosure for the family quote and binds what it returned", async () => {
    const fixture = await seedFamilyQuote("e2e")
    seededTenantId = fixture.tenantId

    // ── Issue. The ONLY source of a token in this test. ──────────────────────
    const { POST: issue } = await import("@/app/api/insurance/quotes/[id]/disclosure/route")
    const issueRes = await issue(
      new NextRequest(`http://localhost/api/insurance/quotes/${fixture.quoteId}/disclosure`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: fixture.quoteId }) },
    )

    expect(issueRes.status).toBe(201)
    const issued = await issueRes.json()
    expect(issued.draftToken).toBeTruthy()
    expect(issued.pdfUrl).toContain(issued.draftToken)

    // ── Bind with exactly that token. ───────────────────────────────────────
    const result = await bindQuote(store, {
      tenantId: fixture.tenantId,
      quoteId: fixture.quoteId,
      draftToken: issued.draftToken,
      startDate: START,
      now: NOW,
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return

    // The policy carries the family TOTAL, not one life's premium.
    const policy = await prisma.insurancePolicy.findUniqueOrThrow({ where: { id: result.policyId } })
    expect(policy.premiumAmount.toFixed(2)).toBe("83.00")
    expect(policy.sumAssured.toFixed(2)).toBe("20000.00")
    expect(policy.policySource).toBe("STANDALONE")
    expect(policy.faisDisclosureAt).not.toBeNull()

    // Both lives are on the policy and ACTIVE.
    const lives = await prisma.insuredLife.findMany({ where: { policyId: result.policyId } })
    expect(lives).toHaveLength(2)
    expect(lives.every((l) => l.status === "ACTIVE")).toBe(true)
    expect(lives.map((l) => l.premiumAmount?.toFixed(2)).sort()).toEqual(["38.00", "45.00"])

    const quote = await prisma.insuranceQuote.findUniqueOrThrow({ where: { id: fixture.quoteId } })
    expect(quote.status).toBe("CONVERTED")
    expect(quote.convertedPolicyId).toBe(result.policyId)
  })

  it("refuses a token issued for a DIFFERENT quote", async () => {
    // The token is bound to its quote, so it is not fungible between two
    // quotes that happen to share a client, product and totals.
    const a = await seedFamilyQuote("bind_a")
    const b = await seedFamilyQuote("bind_b")
    seededTenantId = a.tenantId

    const { POST: issue } = await import("@/app/api/insurance/quotes/[id]/disclosure/route")
    const res = await issue(
      new NextRequest(`http://localhost/api/insurance/quotes/${a.quoteId}/disclosure`, {
        method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: a.quoteId }) },
    )
    const issued = await res.json()

    seededTenantId = b.tenantId
    const result = await bindQuote(store, {
      tenantId: b.tenantId, quoteId: b.quoteId,
      draftToken: issued.draftToken, startDate: START, now: NOW,
    })

    expect(result).toMatchObject({ ok: false })
  })
})
