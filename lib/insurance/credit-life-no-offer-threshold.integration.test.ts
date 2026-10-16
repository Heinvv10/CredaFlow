/**
 * The approval guard's no-offer rule against a migrated PostgreSQL (Fair Score
 * audit B6, migration 20261016152000_credit_life_no_offer_below_threshold).
 *
 * guardLoanApplicationCreditLifeOffer refused a no-offer record at approval
 * whenever any active credit-life product existed. Cover cannot be added at or
 * below the R1,000 threshold, so there the record is true and must be accepted;
 * above it the old refusal stands.
 *
 * The real function is attached to a temporary copy of LoanApplication, so the
 * test exercises exactly the deployed trigger body without building a whole
 * approval (bureau, PASQ, affordability) around it.
 *
 *   RUN_CREDIT_LIFE_NO_OFFER_THRESHOLD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-no-offer-threshold.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS } from "./credit-life-election"

const suite = process.env.RUN_CREDIT_LIFE_NO_OFFER_THRESHOLD_IT === "1" ? describe : describe.skip

suite("approval guard: no-offer record and the credit-life threshold", () => {
  const prisma = new PrismaClient()
  const T = "t_cl_threshold_it"

  beforeAll(async () => {
    await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, slug: "cl-threshold-it", name: "CL Threshold IT" } })
    await prisma.insurer.upsert({
      where: { id: "ins_cl_threshold" },
      update: { active: true },
      create: { id: "ins_cl_threshold", tenantId: T, name: "Synthetic Insurer", active: true },
    })
    await prisma.insuranceProduct.upsert({
      where: { id: "prod_cl_threshold" },
      update: { active: true },
      create: {
        id: "prod_cl_threshold", tenantId: T, code: "CL-IT", name: "Synthetic Credit Life", type: "CREDIT_LIFE",
        premiumAmount: 4.5, sumAssured: 1000, insurerId: "ins_cl_threshold", active: true,
      },
    })
  })

  afterAll(async () => { await prisma.$disconnect() })

  /** Inserts an APPROVED no-offer row through the real guard; resolves to the error message, or null. */
  async function approveNoOffer(appliedAmount: number, approvedAmount: number | null): Promise<string | null> {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE guarded_app (LIKE "LoanApplication" INCLUDING DEFAULTS) ON COMMIT DROP`)
        await tx.$executeRawUnsafe(
          `CREATE TRIGGER guard BEFORE INSERT ON guarded_app FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationCreditLifeOffer"()`,
        )
        await tx.$executeRawUnsafe(
          `INSERT INTO guarded_app ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays",
             "approvedAmount", "status", "creditLifeDisclosureVersion", "creditLifeElection", "updatedAt")
           VALUES ('app_cl_it', $1, 'APP-CL-IT', 'c', 'p', $2, 30, $3, 'APPROVED', 'credit-life-no-offer-v1', 'DECLINED', now())`,
          T, appliedAmount, approvedAmount,
        )
        throw new Error("rollback")
      })
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return message === "rollback" ? null : message
    }
  }

  it("accepts a no-offer approval at the threshold although a product is active", async () => {
    expect(await approveNoOffer(CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS, CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS)).toBeNull()
    expect(await approveNoOffer(50_000, null)).toBeNull()
  })

  it("refuses it above the threshold while a product is active", async () => {
    expect(await approveNoOffer(CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS + 1, null))
      .toMatch(/cover became available after this application recorded that none was offered/)
  })

  it("refuses it when the approved amount exceeds the threshold", async () => {
    expect(await approveNoOffer(CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS, 150_000))
      .toMatch(/none was offered/)
  })

  it("re-checks an approved no-offer row when its approved amount rises above the threshold", async () => {
    let message: string | null = null
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE guarded_app (LIKE "LoanApplication" INCLUDING DEFAULTS) ON COMMIT DROP`)
        await tx.$executeRawUnsafe(
          `INSERT INTO guarded_app ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays",
             "approvedAmount", "status", "creditLifeDisclosureVersion", "creditLifeElection", "updatedAt")
           VALUES ('app_cl_it', $1, 'APP-CL-IT', 'c', 'p', 80000, 30, 80000, 'APPROVED', 'credit-life-no-offer-v1', 'DECLINED', now())`,
          T,
        )
        await tx.$executeRawUnsafe(
          `CREATE TRIGGER guard BEFORE UPDATE ON guarded_app FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationCreditLifeOffer"()`,
        )
        await tx.$executeRawUnsafe(`UPDATE guarded_app SET "approvedAmount" = 150000 WHERE "id" = 'app_cl_it'`)
        throw new Error("rollback")
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/none was offered/)
  })
})
