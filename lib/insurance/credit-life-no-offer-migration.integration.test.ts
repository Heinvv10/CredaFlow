/**
 * Proves the SQL mirrors of the credit-life hashes agree with the TypeScript
 * ones, and that relaxing the CHECK constraint did not weaken it.
 *
 * The whole no-offer state rests on two PL/pgSQL functions reproducing
 * TypeScript hashing byte-for-byte. If they drift, `pasqEvidenceSha256V3`
 * returns NULL, the `pasq_v3_complete` CHECK reads that NULL as `IS TRUE` =
 * false, and approval silently stops working — with no unit test able to see it.
 *
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_CREDIT_LIFE_NO_OFFER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-no-offer-migration.integration.test.ts
 */
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { pasqEvidenceSha256 } from "@/lib/compliance/pasq"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
} from "@/lib/insurance/credit-life-election"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"

const suite = process.env.RUN_CREDIT_LIFE_NO_OFFER_IT === "1"
  ? describe
  : describe.skip

const PRINCIPAL_CENTS = 100_000
const TERM_DAYS = 30

const CALCULATOR_SCHEDULE = [{
  installmentNo: 1,
  dueDate: "2026-08-27",
  principalDueCents: 100_000,
  interestDueCents: 5_000,
  feesDueCents: 6_900,
  totalDueCents: 111_900,
  openingBalanceCents: 100_000,
  closingBalanceCents: 0,
}]

const BILLING_SCHEDULE = [{
  installmentNo: 1,
  dueDate: "2026-08-27",
  principalDueCents: 100_000,
  interestDueCents: 5_000,
  baseFeesDueCents: 6_900,
  creditLifePremiumDueCents: 0,
  feesDueCents: 6_900,
  totalDueCents: 111_900,
  openingBalanceCents: 100_000,
  closingBalanceCents: 0,
}]

function evidence(creditLife: Record<string, unknown>) {
  return {
    version: "pasq-v3" as const,
    tenantId: "tenant-1",
    applicationId: "app-1",
    clientId: "client-1",
    productId: "product-1",
    termDays: TERM_DAYS,
    generatedAt: "2026-07-28T10:00:00.000Z",
    calculator: {
      version: "affordability-calculator-v1",
      startDate: "2026-07-28",
      principalCents: PRINCIPAL_CENTS,
      totalInterestCents: 5_000,
      initiationFeeCents: 15_000,
      serviceFeesCents: 6_900,
      totalRepayableCents: 126_900,
      disbursementAmountCents: 100_000,
      recurringInstalmentCents: 126_900,
      schedule: CALCULATOR_SCHEDULE,
      pricingFingerprint: "a".repeat(64),
      contractFingerprint: "b".repeat(64),
    },
    creditLife,
    billing: {
      version: "credit-life-billing-v1" as const,
      collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT" as const,
      recurringPaymentCents: 126_900,
      totalRepayableCents: 126_900,
      schedule: BILLING_SCHEDULE,
    },
    totalCostOfCreditCents: 126_900,
  }
}

const NO_OFFER_SHA = createCreditLifeNoOfferDisclosureSha256({
  version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  election: "DECLINED",
  principalCents: PRINCIPAL_CENTS,
  termDays: TERM_DAYS,
})

const OFFER_SHA = createCreditLifeDisclosureSha256({
  version: CREDIT_LIFE_DISCLOSURE_VERSION,
  election: "DECLINED",
  principalCents: PRINCIPAL_CENTS,
  termDays: TERM_DAYS,
  monthlyPremiumCents: 450,
  productId: "cl-1",
  productName: "Acme Credit Life",
  insurerId: "ins-1",
  insurerName: "Clientele Life",
})

const OFFER_EVIDENCE = evidence({
  election: "DECLINED",
  productId: "cl-1",
  productName: "Acme Credit Life",
  insurerId: "ins-1",
  insurerName: "Clientele Life",
  monthlyPremiumCents: 450,
  premiumPeriods: 1,
  totalPremiumCents: 0,
  disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
  disclosureSha256: OFFER_SHA,
})

const NO_OFFER_EVIDENCE = evidence({
  election: "DECLINED",
  productId: null,
  productName: null,
  insurerId: null,
  insurerName: null,
  monthlyPremiumCents: 0,
  premiumPeriods: 1,
  totalPremiumCents: 0,
  disclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  disclosureSha256: NO_OFFER_SHA,
})

async function sqlEvidenceHash(ev: unknown): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ h: string | null }>>(
    `SELECT "pasqEvidenceSha256V3"($1::jsonb) AS h`,
    JSON.stringify(ev),
  )
  return rows[0].h
}

async function sqlMatches(
  ev: unknown,
  over: Record<string, unknown> = {},
): Promise<boolean | null> {
  const a = {
    election: "DECLINED",
    productId: null as string | null,
    productName: null as string | null,
    insurerId: null as string | null,
    insurerName: null as string | null,
    premium: 0,
    version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION as string,
    sha: NO_OFFER_SHA,
    ...over,
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ m: boolean | null }>>(
    `SELECT "pasqCreditLifeMatchesApplication"(
       $1::jsonb, $2, $3, $4, $5, $6, $7::int, $8, $9,
       '2026-07-28 09:00:00'::timestamp(3), 'client-1', 'client-1',
       ${PRINCIPAL_CENTS}, ${TERM_DAYS},
       '2026-07-28 10:00:00'::timestamp(3)) AS m`,
    JSON.stringify(ev), a.election, a.productId, a.productName,
    a.insurerId, a.insurerName, a.premium, a.version, a.sha,
  )
  return rows[0].m
}

suite("credit-life no-offer migration", () => {
  it("mirrors the no-offer disclosure hash in SQL", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ h: string }>>(
      `SELECT "creditLifeNoOfferDisclosureSha256"(
         $1, 'DECLINED', ${PRINCIPAL_CENTS}, ${TERM_DAYS}) AS h`,
      CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
    )
    expect(rows[0].h).toBe(NO_OFFER_SHA)
  })

  it("hashes the offer path identically to TypeScript", async () => {
    // Regression guard: any drift here stops every already-approved
    // application from verifying against its stored pasqEvidenceSha256.
    expect(await sqlEvidenceHash(OFFER_EVIDENCE))
      .toBe(pasqEvidenceSha256(OFFER_EVIDENCE as never))
  })

  it("hashes the no-offer path identically to TypeScript", async () => {
    expect(await sqlEvidenceHash(NO_OFFER_EVIDENCE))
      .toBe(pasqEvidenceSha256(NO_OFFER_EVIDENCE as never))
  })

  it("does not let the two disclosure shapes collide", () => {
    expect(pasqEvidenceSha256(OFFER_EVIDENCE as never))
      .not.toBe(pasqEvidenceSha256(NO_OFFER_EVIDENCE as never))
  })

  it("refuses to hash no-offer evidence that smuggles an offer identity", async () => {
    expect(await sqlEvidenceHash(evidence({
      ...NO_OFFER_EVIDENCE.creditLife,
      productId: "cl-1",
      insurerId: "ins-1",
    }))).toBeNull()
  })

  it("rejects a legacy all-NULL application in the PASQ match guard", async () => {
    // Dropping STRICT means NULL arguments no longer short-circuit to NULL --
    // the explicit guard must reject them instead.
    const rows = await prisma.$queryRawUnsafe<Array<{ m: boolean | null }>>(
      `SELECT "pasqCreditLifeMatchesApplication"(
         $1::jsonb, NULL, NULL, NULL, NULL, NULL, NULL::int, NULL, NULL,
         NULL::timestamp(3), NULL, 'client-1',
         ${PRINCIPAL_CENTS}, ${TERM_DAYS},
         '2026-07-28 10:00:00'::timestamp(3)) AS m`,
      JSON.stringify(NO_OFFER_EVIDENCE),
    )
    expect(rows[0].m).toBe(false)
  })

  it("accepts a no-offer application in the PASQ match guard", async () => {
    expect(await sqlMatches(NO_OFFER_EVIDENCE)).toBe(true)
  })

  it("rejects no-offer applications that carry an offer or a premium", async () => {
    expect(await sqlMatches(NO_OFFER_EVIDENCE, { productId: "cl-1" })).toBe(false)
    expect(await sqlMatches(NO_OFFER_EVIDENCE, { premium: 450 })).toBe(false)
    expect(await sqlMatches(NO_OFFER_EVIDENCE, { election: "ACCEPTED" })).toBe(false)
    expect(await sqlMatches(NO_OFFER_EVIDENCE, { version: "credit-life-made-up-v9" }))
      .toBe(false)
  })

  describe("CHECK constraint shapes", () => {
    async function probe(values: string): Promise<boolean> {
      const [{ def }] = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'LoanApplication_credit_life_election_complete'`,
      )
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS cl_check_probe`)
      await prisma.$executeRawUnsafe(`
        CREATE TABLE cl_check_probe (
          "creditLifeElection" "CreditLifeElection", "creditLifeProductId" TEXT,
          "creditLifeProductName" TEXT, "creditLifeInsurerId" TEXT,
          "creditLifeInsurerName" TEXT, "creditLifeMonthlyPremiumCents" INTEGER,
          "creditLifeDisclosureVersion" TEXT, "creditLifeDisclosureSha256" TEXT,
          "creditLifeDisclosureAcknowledgedAt" TIMESTAMP(3),
          "creditLifeDisclosureAcknowledgedBy" TEXT,
          ${def.replace(/^CHECK/, "CONSTRAINT probe CHECK")}
        )`)
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO cl_check_probe VALUES (${values})`,
        )
        return true
      } catch {
        return false
      } finally {
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS cl_check_probe`)
      }
    }

    const SHA = `'${"a".repeat(64)}'`

    it("still accepts a legacy all-null row", async () => {
      expect(await probe("NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL"))
        .toBe(true)
    })

    it("accepts a decline recorded against no offer", async () => {
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,0,'credit-life-no-offer-v1',${SHA},NOW(),'client-1'`,
      )).toBe(true)
    })

    it("rejects a no-offer row carrying any offer identity", async () => {
      expect(await probe(
        `'DECLINED','cl-1',NULL,NULL,NULL,0,'credit-life-no-offer-v1',${SHA},NOW(),'client-1'`,
      )).toBe(false)
    })

    it("rejects a no-offer ACCEPTED election", async () => {
      expect(await probe(
        `'ACCEPTED',NULL,NULL,NULL,NULL,0,'credit-life-no-offer-v1',${SHA},NOW(),'client-1'`,
      )).toBe(false)
    })

    it("rejects a no-offer row with a premium", async () => {
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,450,'credit-life-no-offer-v1',${SHA},NOW(),'client-1'`,
      )).toBe(false)
    })

    it("still accepts a complete offer election", async () => {
      expect(await probe(
        `'DECLINED','cl-1','Acme CL','ins-1','Clientele',450,'credit-life-election-v1',${SHA},NOW(),'client-1'`,
      )).toBe(true)
    })

    it("rejects a half-written no-offer row with NULL columns", async () => {
      // Three-valued logic: these comparisons yield NULL, and a bare CHECK
      // ACCEPTS NULL. Only the `IS TRUE` wrapper rejects them.
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,0,'credit-life-no-offer-v1',NULL,NOW(),'client-1'`,
      )).toBe(false)
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,NULL,'credit-life-no-offer-v1',${SHA},NOW(),'client-1'`,
      )).toBe(false)
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,0,NULL,${SHA},NOW(),'client-1'`,
      )).toBe(false)
      expect(await probe(
        `'DECLINED',NULL,NULL,NULL,NULL,0,'credit-life-no-offer-v1',${SHA},NULL,'client-1'`,
      )).toBe(false)
    })

    it("still rejects a half-populated offer election", async () => {
      expect(await probe(
        `'DECLINED','cl-1',NULL,'ins-1','Clientele',450,'credit-life-election-v1',${SHA},NOW(),'client-1'`,
      )).toBe(false)
    })
  })
})
