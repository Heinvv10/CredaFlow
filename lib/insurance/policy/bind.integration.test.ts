/**
 * Run only against a throwaway, fully migrated PostgreSQL database:
 *
 *   RUN_IMS_BIND_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/policy/bind.integration.test.ts
 *
 * WHY THIS EXISTS ALONGSIDE THE MOCKED SUITE. A mocked Prisma cannot execute a
 * CHECK constraint. `bind.test.ts` proves the bind SETS `policySource`,
 * `faisDisclosureAt` and `faisDisclosurePdfUrl`; only a real Postgres proves
 * that setting them is what the database actually demands — and that omitting
 * them is refused rather than quietly stored. Same for the single-use token:
 * the unique index is the enforcement, and a mock cannot raise P2002.
 *
 * The suite skips itself without RUN_IMS_BIND_IT=1, which means a green run of
 * the default suite says NOTHING about these guarantees. That is the documented
 * failure mode of this repo's opt-in integration suites, so treat an unrun
 * skip as absent coverage, never as a pass.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { PrismaClient } from "@prisma/client"
import { beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { signDraftToken } from "../disclosure-token"
import { hashDraftToken } from "../disclosure-token"
import { bindQuote } from "./bind"

const RUN = process.env.RUN_IMS_BIND_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 12)

const START = new Date("2026-09-01T00:00:00Z")
// The bind refuses a backdated start (B4), so a fixed START needs a fixed
// clock to stay in the future; pinned rather than left to the wall clock.
const NOW = new Date("2026-08-20T00:00:00Z")

// Variance cast for the $extends client, as elsewhere in this module: the
// generic delegate signatures of an extended client are not assignable to the
// plain PrismaClient the store types are written against. Runtime shape is
// identical — this is the SAME client, and every statement below really does
// hit the database.
const store = prisma as unknown as PrismaClient

interface Fixture {
  tenantId: string
  clientId: string
  productId: string
  quoteId: string
}

/** A tenant, client, product, rate card, ACCEPTED quote with advice and two lives. */
async function seedBindableQuote(label: string): Promise<Fixture> {
  const suffix = `${label}_${token}`
  const tenantId = `t_${suffix}`

  await prisma.tenant.create({
    data: { id: tenantId, name: `IT ${suffix}`, slug: `it-${suffix}` },
  })

  const client = await prisma.client.create({
    data: {
      tenantId,
      firstName: "Thandi",
      lastName: "Nkosi",
      idNumber: `ID${suffix}`.slice(0, 13).padEnd(13, "0"),
      email: `${suffix}@example.test`,
      phone: "0820000000",
      dateOfBirth: new Date("1990-05-10T00:00:00Z"),
    },
  })

  const product = await prisma.insuranceProduct.create({
    data: {
      tenantId,
      code: `FUN_${suffix}`.slice(0, 20),
      name: "Family Funeral",
      type: "FUNERAL_COVER",
      premiumAmount: "0.00",
      sumAssured: "0.00",
      commissionRate: "0.1500",
    },
  })

  const rateTable = await prisma.insuranceRateTable.create({
    data: {
      tenantId,
      productId: product.id,
      version: 1,
      name: "2026 card",
      status: "ACTIVE",
      basis: "AGE_BANDED",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      bands: {
        create: [
          { lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "45.00" },
          { lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "10000.00", premiumAmount: "38.00" },
        ],
      },
    },
    include: { bands: true },
  })

  // All four MANDATORY rule types. The bind RE-SCREENS now, so a fixture
  // carrying only the waiting period is refused as NOT_ELIGIBLE before it
  // reaches any of the assertions below.
  await prisma.insuranceEligibilityRule.createMany({
    data: [
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MIN_ENTRY_AGE", numericValue: "18" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MAX_ENTRY_AGE", numericValue: "75" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "20000" },
      { tenantId, productId: product.id, lifeScope: "ALL_LIVES", ruleType: "WAITING_PERIOD_DAYS", numericValue: "180" },
    ],
  })

  const quote = await prisma.insuranceQuote.create({
    data: {
      tenantId,
      clientId: client.id,
      productId: product.id,
      quoteNumber: `QTE_${suffix}`,
      status: "ACCEPTED",
      rateTableId: rateTable.id,
      totalPremium: "83.00",
      totalSumAssured: "20000.00",
      effectiveDate: START,
      eligibilityResult: { pass: true, failures: [] },
      lives: {
        create: [
          {
            clientId: client.id, firstName: "Thandi", lastName: "Nkosi",
            dateOfBirth: new Date("1990-05-10T00:00:00Z"), relationship: "SELF",
            lifeType: "MAIN_MEMBER", sumAssured: "10000.00", premiumAmount: "45.00",
            rateBandId: rateTable.bands.find((b) => b.lifeType === "MAIN_MEMBER")!.id,
          },
          {
            firstName: "Sipho", lastName: "Nkosi",
            dateOfBirth: new Date("1988-03-01T00:00:00Z"), relationship: "SPOUSE",
            lifeType: "SPOUSE", sumAssured: "10000.00", premiumAmount: "38.00",
            rateBandId: rateTable.bands.find((b) => b.lifeType === "SPOUSE")!.id,
          },
        ],
      },
      adviceRecord: {
        create: {
          tenantId,
          needsAnalysis: "Sole earner, three dependants.",
          productsConsidered: [{ code: "FUN-10K" }],
          recommendation: "FUN-10K",
          clientDecision: "ACCEPTED_RECOMMENDATION",
          contentHash: "0".repeat(64),
        },
      },
    },
  })

  return { tenantId, clientId: client.id, productId: product.id, quoteId: quote.id }
}

/**
 * A second ACCEPTED quote for the SAME tenant, client and product.
 *
 * Necessary for the replay test specifically: a token carries clientId and
 * productId, so redeeming it against a quote in ANOTHER tenant is refused as
 * TOKEN_MISMATCH before the replay check is ever reached. Isolating replay
 * means holding everything the token binds constant and varying only the quote.
 */
async function seedSiblingQuote(fixture: Fixture, label: string): Promise<string> {
  const quote = await prisma.insuranceQuote.create({
    data: {
      tenantId: fixture.tenantId,
      clientId: fixture.clientId,
      productId: fixture.productId,
      quoteNumber: `QTE_${label}_${token}`,
      status: "ACCEPTED",
      totalPremium: "83.00",
      totalSumAssured: "20000.00",
      effectiveDate: START,
      eligibilityResult: { pass: true, failures: [] },
      lives: {
        create: [{
          firstName: "Thandi", lastName: "Nkosi",
          dateOfBirth: new Date("1990-05-10T00:00:00Z"), relationship: "SELF",
          lifeType: "MAIN_MEMBER", sumAssured: "20000.00", premiumAmount: "83.00",
        }],
      },
      adviceRecord: {
        create: {
          tenantId: fixture.tenantId,
          needsAnalysis: "Sibling quote.",
          productsConsidered: [{ code: "FUN-10K" }],
          recommendation: "FUN-10K",
          clientDecision: "ACCEPTED_RECOMMENDATION",
          contentHash: "0".repeat(64),
        },
      },
    },
  })
  return quote.id
}

function tokenFor(fixture: Fixture, overrides: Partial<{ premiumAmount: number; quoteId: string }> = {}) {
  return signDraftToken({
    quoteId: overrides.quoteId ?? fixture.quoteId,
    tenantId: fixture.tenantId,
    clientId: fixture.clientId,
    advisorId: "unused",
    type: "FUNERAL_COVER",
    sumAssured: 20000,
    premiumAmount: overrides.premiumAmount ?? 83,
    productId: fixture.productId,
  })
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "it-secret-do-not-use-in-prod-1234567890"
})

suite("bindQuote against real Postgres", () => {
  it("binds a quote, and the row satisfies the STANDALONE CHECK constraint", async () => {
    const fixture = await seedBindableQuote("happy")
    const result = await bindQuote(store, {
      tenantId: fixture.tenantId,
      quoteId: fixture.quoteId,
      draftToken: tokenFor(fixture),
      startDate: START,
      now: NOW,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const policy = await prisma.insurancePolicy.findUniqueOrThrow({ where: { id: result.policyId } })
    // Postgres accepted the row, which it only does when the CHECK is met.
    expect(policy.policySource).toBe("STANDALONE")
    expect(policy.faisDisclosureAt).not.toBeNull()
    expect(policy.faisDisclosurePdfUrl).not.toBeNull()
    expect(policy.premiumAmount.toFixed(2)).toBe("83.00")
    expect(policy.sumAssured.toFixed(2)).toBe("20000.00")

    const lives = await prisma.insuredLife.findMany({ where: { policyId: result.policyId } })
    expect(lives).toHaveLength(2)
    expect(lives.every((life) => life.status === "ACTIVE")).toBe(true)
    // 180 days after 2026-09-01.
    expect(lives[0].waitingPeriodEnds).toEqual(new Date("2027-02-28T00:00:00Z"))

    const quote = await prisma.insuranceQuote.findUniqueOrThrow({ where: { id: fixture.quoteId } })
    expect(quote.status).toBe("CONVERTED")
    expect(quote.convertedPolicyId).toBe(result.policyId)

    // P2 — the policy is billable. Asserted against the real table because the
    // renewal cron selects on `premiumPayments: { some: ... }`; a policy with
    // no rows here is invisible to it and never lapses, renews or bills.
    const schedule = await prisma.premiumPayment.findMany({
      where: { policyId: result.policyId },
      orderBy: { dueDate: "asc" },
    })
    expect(schedule).toHaveLength(12)
    expect(schedule[0].amount.toFixed(2)).toBe("83.00")
    expect(schedule.every((row) => row.status === "DUE")).toBe(true)
    expect(schedule.every((row) => row.tenantId === fixture.tenantId)).toBe(true)
    // Twelve distinct months, not twelve rows on the same date.
    expect(new Set(schedule.map((row) => row.dueDate.toISOString())).size).toBe(12)
  })

  it("PROVES the CHECK constraint is live: a STANDALONE row without the FAIS pointers is REJECTED", async () => {
    // If this insert succeeded, the constraint the bind is written to satisfy
    // would not actually exist, and every other assertion here would be
    // theatre. This is the test that makes the rest mean something.
    const fixture = await seedBindableQuote("check")
    await expect(
      prisma.insurancePolicy.create({
        data: {
          tenantId: fixture.tenantId,
          policyNumber: `CHK-${token}`,
          clientId: fixture.clientId,
          type: "FUNERAL_COVER",
          status: "ACTIVE",
          premiumAmount: "83.00",
          sumAssured: "20000.00",
          startDate: START,
          renewalDate: new Date("2027-09-01T00:00:00Z"),
          policySource: "STANDALONE",
          faisDisclosureAt: null,
          faisDisclosurePdfUrl: null,
        },
      })
    ).rejects.toThrow(/InsurancePolicy_standalone_fais_required|violates check constraint/i)
  })

  it("makes the disclosure token single-use — the unique index is the backstop", async () => {
    const first = await seedBindableQuote("replay_a")
    const shared = tokenFor(first)
    const bound = await bindQuote(store, {
      tenantId: first.tenantId, quoteId: first.quoteId, draftToken: shared, startDate: START, now: NOW,
    })
    expect(bound.ok).toBe(true)

    // NOTE ON WHAT CHANGED. Cross-quote replay is now impossible by
    // CONSTRUCTION rather than by detection: the token names its quote, so
    // redeeming it against a different one is refused as TOKEN_MISMATCH before
    // the replay check is consulted. The in-code replay check therefore still
    // guards the legacy single-life path, and the unique index below is what
    // makes the property true at the database rather than in a code path that
    // may be reordered.
    const sibling = await seedSiblingQuote(first, "replay_b")
    const crossQuote = await bindQuote(store, {
      tenantId: first.tenantId, quoteId: sibling, draftToken: shared, startDate: START, now: NOW,
    })
    expect(crossQuote).toMatchObject({ ok: false, reason: "TOKEN_MISMATCH" })

    // The index itself: a second policy carrying the same token hash is
    // rejected by Postgres, whatever the application layer does.
    await expect(
      prisma.insurancePolicy.create({
        data: {
          tenantId: first.tenantId,
          policyNumber: `DUP-${token}`,
          clientId: first.clientId,
          type: "FUNERAL_COVER",
          status: "ACTIVE",
          premiumAmount: "83.00",
          sumAssured: "20000.00",
          startDate: START,
          renewalDate: new Date("2027-09-01T00:00:00Z"),
          policySource: "STANDALONE",
          faisDisclosureAt: new Date(),
          faisDisclosurePdfUrl: "/api/insurance/disclosures/x",
          faisDraftTokenHash: hashDraftToken(shared),
        },
      })
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError)
  })

  it("refuses to bind the same quote twice", async () => {
    const fixture = await seedBindableQuote("twice")
    const first = await bindQuote(store, {
      tenantId: fixture.tenantId, quoteId: fixture.quoteId, draftToken: tokenFor(fixture), startDate: START, now: NOW,
    })
    expect(first.ok).toBe(true)

    // A fresh token, so this is refused for being already converted rather
    // than for replaying a token.
    const second = await bindQuote(store, {
      tenantId: fixture.tenantId,
      quoteId: fixture.quoteId,
      draftToken: signDraftToken({
        tenantId: fixture.tenantId, clientId: fixture.clientId, advisorId: "unused",
        type: "FUNERAL_COVER", sumAssured: 20000, premiumAmount: 83, productId: fixture.productId,
      }),
      startDate: START,
      now: NOW,
    })
    expect(second).toMatchObject({ ok: false, reason: "ALREADY_CONVERTED" })

    const policies = await prisma.insurancePolicy.count({ where: { tenantId: fixture.tenantId } })
    expect(policies).toBe(1)
  })
})
