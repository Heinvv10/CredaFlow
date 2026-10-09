/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_OUTAGE_DISBURSEMENT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run \
 *       lib/disbursement/outage-exception-migration.integration.test.ts
 *
 * The outage-exception allow-list is intentionally EMPTY in this product, in the
 * Postgres functions and in lib/disbursement/outage-exception.ts. Every test here
 * proves a REFUSAL against the live triggers: no application can be bound to a
 * disbursement exception, and no exception evidence can be recorded. All ids and
 * names are synthetic and randomised per test.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { createApplicationContractFixture } from
  "@/lib/compliance/signed-debit-mandate.integration-fixture"
import { createCreditLifeNoOfferDisclosureSha256 } from
  "@/lib/insurance/credit-life-election.server"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from
  "@/lib/insurance/credit-life-election"

const suite = process.env.RUN_OUTAGE_DISBURSEMENT_IT === "1"
  ? describe
  : describe.skip

const PAYOUT_AT = new Date("2026-01-01T10:00:00.000Z")
const RECONCILED_AT = new Date("2026-01-02T09:30:00.000Z")

type Scenario = Awaited<ReturnType<typeof createApprovedScenario>>

/** An APPROVED application, EFT, credit life declined: the shape the guard requires. */
async function createApprovedScenario() {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_outage_${token}`
  const clientId = `client_outage_${token}`
  const productId = `product_outage_${token}`
  const officerId = `officer_outage_${token}`
  const officerEmail = `outage-${token}@example.invalid`
  const applicationId = `application_outage_${token}`
  const applicationReference = `APP-TEST-${token.slice(0, 8).toUpperCase()}`
  const pasqDocumentId = `pasq_outage_${token}`
  const pasqDocumentSha256 = "a".repeat(64)
  const exceptionId = `exception_outage_${token}`
  const generatedAt = new Date("2026-01-01T08:00:00.000Z")
  const disclosedAt = new Date("2026-01-01T07:59:00.000Z")
  const disclosureSha256 = createCreditLifeNoOfferDisclosureSha256({
    version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
    election: "DECLINED",
    principalCents: 100_000,
    termDays: 30,
  })
  const { affordabilityResult } = createApplicationContractFixture({
    applicationId,
    productId,
    officerId,
    pricing: {
      principal: 100_000,
      termDays: 30,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED",
    },
    quotePresentedAt: generatedAt,
    agreementEstablishedAt: generatedAt,
    acceptedPasqDocumentSha256: pasqDocumentSha256,
  })
  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays: 30,
    generatedAt,
    calculator: affordabilityResult.approval.calculator,
    creditLife: {
      election: "DECLINED",
      productId: null,
      productName: null,
      insurerId: null,
      insurerName: null,
      monthlyPremiumCents: 0,
      disclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      disclosureSha256,
    },
  })

  await prisma.tenant.create({
    data: { id: tenantId, slug: `outage-${token}`, name: "Outage test tenant" },
  })
  await prisma.user.create({
    data: {
      id: officerId,
      tenantId,
      email: officerEmail,
      name: "Test Officer",
      password: "not-a-real-login",
      role: "SUPER_ADMIN",
    },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `OUTAGE-${token}`,
      name: "Test micro loan",
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
    },
  })
  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-${token}`,
      idNumber: `TEST-ID-${token}`,
      firstName: "Test",
      lastName: "Client",
      email: `client-${token}@example.invalid`,
      phone: "+27820000000",
      grossMonthlyIncome: 2_000_000,
      monthlyIncome: 2_000_000,
      monthlyExpenses: 800_000,
      bankName: "TEST BANK",
      bankAccountNumber: "0000000001",
      bankBranchCode: "000000",
      accountType: "CHEQUE",
    },
  })
  await prisma.clientDocument.create({
    data: {
      id: pasqDocumentId,
      tenantId,
      clientId,
      docType: "FORM_20_PRE_AGREEMENT",
      fileUrl: `/api/applications/${applicationId}/pasq`,
      fileName: `pasq-${applicationId}.pdf`,
      fileSize: 4096,
      mimeType: "application/pdf",
      storagePath: `/tmp/pasq-${applicationId}.pdf`,
      contentSha256: pasqDocumentSha256,
      extractionStatus: "skipped",
    },
  })
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: applicationReference,
      clientId,
      productId,
      appliedAmount: 100_000,
      appliedTermDays: 30,
      status: "UNDER_REVIEW",
      affordabilityResult: {
        schemaVersion: affordabilityResult.schemaVersion,
      },
      recklessLendingAssessed: true,
      recklessLendingAssessedAt: generatedAt,
      recklessLendingAssessedById: officerId,
      clientAffordabilityDeclaredAt: generatedAt,
      creditLifeElection: "DECLINED",
      creditLifeMonthlyPremiumCents: 0,
      creditLifeDisclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      creditLifeDisclosureSha256: disclosureSha256,
      creditLifeDisclosureAcknowledgedAt: disclosedAt,
      creditLifeDisclosureAcknowledgedBy: clientId,
    },
  })
  await prisma.loanApplication.update({
    where: { id: applicationId, tenantId },
    data: {
      status: "APPROVED",
      approvedAmount: 100_000,
      approvedTermDays: 30,
      approvedRate: 0.05,
      approvedAt: generatedAt,
      approvedById: officerId,
      repaymentMethod: "EFT",
      totalExistingDebt: affordabilityResult.approval.inputs.declaredDebtCents,
      netDisposableIncome:
        affordabilityResult.approval.outcome.netDisposableIncomeCents,
      affordabilityNDI: affordabilityResult.approval.outcome.ndiAfterLoanCents,
      affordabilityResult: {
        schemaVersion: affordabilityResult.schemaVersion,
        approval: affordabilityResult.approval,
      },
    },
  })
  await prisma.loanApplication.update({
    where: { id: applicationId, tenantId },
    data: {
      pasqVersion: pasqEvidence.version,
      pasqGeneratedAt: generatedAt,
      pasqDocumentId,
      pasqDocumentSha256,
      pasqEvidence,
      pasqEvidenceSha256: pasqEvidence.evidenceSha256,
    },
  })

  // Built by hand: createOutageExceptionEvidence refuses every application now.
  // Every field is well formed, so the ONLY thing wrong with it is that the
  // allow-list names no application.
  const evidence = {
    kind: "DISBURSEMENT_OUTAGE_EXCEPTION",
    version: "disbursement-outage-exception-v1",
    incidentId: "test-incident-0001",
    applicationId,
    applicationReference,
    actualPayoutDate: "2026-01-01",
    timestampPrecision: "DATE",
    managementApprovedBy: "Test Approver",
    managementApprovalNote:
      "Test Approver approved the formal outage reconciliation.",
    waivedPreconditions: ["verified_banking"],
    reconciledById: officerId,
    reconciledByEmail: officerEmail,
    reconciledAt: RECONCILED_AT.toISOString(),
    duplicatePayoutSuppressed: true,
  }

  return {
    tenantId,
    clientId,
    officerId,
    officerEmail,
    applicationId,
    applicationReference,
    exceptionId,
    evidence,
  }
}

function insertExceptionSql(scenario: Scenario) {
  return Prisma.sql`
    INSERT INTO "ComplianceRecord" (
      "id", "tenantId", "type", "referenceId", "idempotencyKey",
      "status", "completedAt", "data", "createdAt", "updatedAt"
    ) VALUES (
      ${scenario.exceptionId},
      ${scenario.tenantId},
      'DISBURSEMENT_EXCEPTION'::"ComplianceType",
      ${scenario.applicationId},
      ${`outage-disbursement:${scenario.applicationId}`},
      'COMPLETED'::"ComplianceStatus",
      ${RECONCILED_AT},
      ${JSON.stringify(scenario.evidence)}::jsonb,
      NOW(),
      NOW()
    )
  `
}

/**
 * Inserts the evidence row with triggers OFF, committed: a record smuggled past
 * the insert guard, as an operator with replica rights could. The binding guard
 * must still refuse to use it.
 */
async function smuggleException(scenario: Scenario): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
    await tx.$executeRaw(insertExceptionSql(scenario))
  })
}

function bindExceptionSql(scenario: Scenario) {
  return Prisma.sql`
    UPDATE "LoanApplication"
    SET
      "status" = 'DISBURSED'::"AppStatus",
      "disbursedAt" = ${PAYOUT_AT},
      "disbursementExceptionId" = ${scenario.exceptionId},
      "disbursementBank" = 'TEST BANK',
      "disbursementAccountNo" = '0000000001',
      "disbursementBranchCode" = '000000',
      "disbursementAccountType" = 'CHEQUE',
      "disbursementRef" = 'TEST CLIENT'
    WHERE "id" = ${scenario.applicationId}
      AND "tenantId" = ${scenario.tenantId}
      AND "status" = 'APPROVED'::"AppStatus"
  `
}

suite.sequential("outage disbursement database exception (empty allow-list)", () => {
  it("refuses well-formed evidence for any application", async () => {
    const scenario = await createApprovedScenario()
    const [result] = await prisma.$queryRaw<Array<{ valid: boolean }>>(
      Prisma.sql`
        SELECT "validOutageDisbursementExceptionValues"(
          ${scenario.tenantId},
          ${scenario.exceptionId},
          'DISBURSEMENT_EXCEPTION'::"ComplianceType",
          ${scenario.applicationId},
          ${`outage-disbursement:${scenario.applicationId}`},
          'COMPLETED'::"ComplianceStatus",
          ${RECONCILED_AT}::timestamp(3),
          ${JSON.stringify(scenario.evidence)}::jsonb
        ) AS valid
      `,
    )
    expect(result.valid).toBe(false)
  })

  it("refuses to record exception evidence for any application", async () => {
    const scenario = await createApprovedScenario()
    await expect(prisma.$executeRaw(insertExceptionSql(scenario)))
      .rejects.toThrow(/Outage disbursement exception evidence is invalid/)
  })

  it("refuses DISBURSED without an exception", async () => {
    const scenario = await createApprovedScenario()
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "LoanApplication"
        SET "status" = 'DISBURSED'::"AppStatus", "disbursedAt" = ${PAYOUT_AT}
        WHERE "id" = ${scenario.applicationId}
          AND "tenantId" = ${scenario.tenantId}
      `)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(/pasq|agreement|constraint/i)
  })

  it("does not treat an exception record that bypassed the insert guard as valid", async () => {
    const scenario = await createApprovedScenario()
    await smuggleException(scenario)

    const [gate] = await prisma.$queryRaw<Array<{ valid: boolean }>>(
      Prisma.sql`
        SELECT "validOutageDisbursementException"(
          ${scenario.tenantId}, ${scenario.applicationId},
          ${scenario.applicationReference},
          ${PAYOUT_AT}::timestamp, ${scenario.exceptionId}
        ) AS valid
      `,
    )
    expect(gate.valid).toBe(false)
  })

  // Separate from the test above on purpose: the binding guard is its own
  // allow-list, and with the evidence and payout-date predicates re-enabled it
  // is the ONLY thing refusing this write. Behind the gate assertion it would
  // never be reached.
  it("refuses to bind an exception record that bypassed the insert guard", async () => {
    const scenario = await createApprovedScenario()
    await smuggleException(scenario)

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw(bindExceptionSql(scenario))
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(
      /not eligible for the fixed outage disbursement exception/,
    )

    const application = await prisma.loanApplication.findUniqueOrThrow({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      select: { status: true, disbursementExceptionId: true },
    })
    expect(application).toEqual({
      status: "APPROVED",
      disbursementExceptionId: null,
    })
  })

  it("keeps exception evidence immutable: no retype, update or delete", async () => {
    const scenario = await createApprovedScenario()
    await smuggleException(scenario)

    await expect(runWithTenant(scenario.tenantId, async () =>
      await prisma.complianceRecord.update({
        where: { id: scenario.exceptionId },
        data: { status: "PENDING" },
      }),
    )).rejects.toThrow(/immutable/i)
    await expect(runWithTenant(scenario.tenantId, async () =>
      await prisma.complianceRecord.delete({
        where: { id: scenario.exceptionId },
      }),
    )).rejects.toThrow(/immutable/i)

    // An ordinary record cannot be retyped into exception evidence either.
    const ordinaryId = `${scenario.exceptionId}_ordinary`
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ComplianceRecord" (
        "id", "tenantId", "type", "referenceId", "status",
        "createdAt", "updatedAt"
      ) VALUES (
        ${ordinaryId}, ${scenario.tenantId}, 'AFFORDABILITY_ASSESSMENT'::"ComplianceType",
        ${scenario.applicationId}, 'PENDING'::"ComplianceStatus", NOW(), NOW()
      )
    `)
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "ComplianceRecord"
      SET "type" = 'DISBURSEMENT_EXCEPTION'::"ComplianceType"
      WHERE "id" = ${ordinaryId}
    `)).rejects.toThrow(/immutable/i)
  })
})
