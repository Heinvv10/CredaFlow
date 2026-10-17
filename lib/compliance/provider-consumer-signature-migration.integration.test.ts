import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PROVIDER_SIGNATURE_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/provider-consumer-signature-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
} from "@/lib/compliance/provider-countersign"
import { calculateLoan } from "@/lib/loan-calculator"
import { createAffordabilityCalculatorEvidence } from "@/lib/affordability/snapshot"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createPasqEvidence } from "@/lib/compliance/pasq"

const suite = process.env.RUN_PROVIDER_SIGNATURE_GUARD_IT === "1"
  ? describe
  : describe.skip

async function createCountersignedApplication(
  label: string,
  mode:
    | "missing"
    | "valid"
    | "forged_signature"
    | "forged_envelope"
    | "null_method",
  providerRole: "LOAN_ADMIN" | "READONLY" = "LOAN_ADMIN",
) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_signature_guard_${label}_${token}`
  const clientId = `client_signature_guard_${label}_${token}`
  const productId = `product_signature_guard_${label}_${token}`
  const applicationId = `application_signature_guard_${label}_${token}`
  const officerId = `officer_signature_guard_${label}_${token}`
  const pasqDocumentId = `pasq_signature_guard_${label}_${token}`
  const pasqSha256 = "a".repeat(64)
  const agreementSha256 = "c".repeat(64)
  const generatedAt = new Date("2026-07-24T08:00:00.000Z")
  const signedAt = new Date("2026-07-24T08:05:00.000Z")
  const countersignedAt = new Date("2026-07-24T08:10:00.000Z")
  const consumerSignatureData = "data:image/png;base64,Y29uc3VtZXI="
  const providerSignatureData = "Synthetic Officer"
  const actualProviderSignatureSha256 =
    providerCountersignatureSha256(providerSignatureData)
  const storedProviderSignatureSha256 = mode === "forged_signature"
    ? "d".repeat(64)
    : actualProviderSignatureSha256
  const providerSignerEmail =
    `signature-guard-officer-${label}-${token}@example.invalid`
  const consumerSignatureSha256 =
    providerCountersignatureSha256(consumerSignatureData)
  const consumerSignedMethod = mode === "null_method" ? null : "portal"
  const consumerSignerId = mode === "null_method" ? null : clientId
  const creditLifeDisclosure = {
    version: "credit-life-election-v1" as const,
    election: "DECLINED" as const,
    principalCents: 500_000,
    termDays: 30,
    monthlyPremiumCents: 2_250,
    productId: `credit-life-${token}`,
    productName: "Synthetic Credit Life",
    insurerId: `insurer-${token}`,
    insurerName: "Synthetic Insurer",
  }
  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays: 30,
    generatedAt,
    calculator: createAffordabilityCalculatorEvidence(calculateLoan({
      principal: 500_000,
      termDays: 30,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0,
      initiationFeeMax: 0,
      monthlyServiceFee: 0,
      initiationFeePayment: "DEFERRED",
    }, generatedAt), generatedAt),
    creditLife: {
      election: creditLifeDisclosure.election,
      productId: creditLifeDisclosure.productId,
      productName: creditLifeDisclosure.productName,
      insurerId: creditLifeDisclosure.insurerId,
      insurerName: creditLifeDisclosure.insurerName,
      monthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256:
        createCreditLifeDisclosureSha256(creditLifeDisclosure),
    },
  })
  const evidenceSha256 = pasqEvidence.evidenceSha256
  const validEnvelopeSha256 = mode === "null_method"
    ? (await prisma.$queryRaw<Array<{ digest: string }>>`
        SELECT "providerCountersignEnvelopeSha256"(
          ${tenantId},
          ${applicationId},
          ${clientId},
          ${agreementSha256},
          ${signedAt}::timestamp(3),
          ${consumerSignedMethod}::text,
          ${consumerSignerId}::text,
          ${consumerSignatureSha256},
          ${countersignedAt}::timestamp(3),
          ${officerId},
          ${"Synthetic Officer"},
          ${providerSignerEmail},
          ${storedProviderSignatureSha256}
        ) AS digest
      `)[0].digest
    : providerCountersignatureEnvelopeSha256({
        tenantId,
        applicationId,
        clientId,
        documentSha256: agreementSha256,
        consumerSignedAt: signedAt,
        consumerSignedMethod: "portal",
        consumerSignerId: clientId,
        consumerSignatureSha256,
        providerCountersignedAt: countersignedAt,
        providerSignerId: officerId,
        providerSignerName: "Synthetic Officer",
        providerSignerEmail,
        providerSignatureSha256: storedProviderSignatureSha256,
      })
  const envelopeSha256 = mode === "missing"
    ? null
    : mode === "forged_envelope"
      ? "e".repeat(64)
      : validEnvelopeSha256

  await prisma.tenant.create({
    data: {
      id: tenantId,
      slug: `signature-guard-${label}-${token}`,
      name: `Signature guard ${label}`,
    },
  })
  // Off, so a direct DISBURSED write meets the envelope gate alone; segregation
  // of duties is proved in lib/security/segregation-of-duties.integration.test.ts.
  await prisma.tenantConfig.create({ data: { tenantId, requireSegregationOfDuties: false } })
  await prisma.user.create({
    data: {
      id: officerId,
      tenantId,
      email: `signature-guard-officer-${label}-${token}@example.invalid`,
      password: "not-a-real-login",
      name: "Synthetic Officer",
      role: providerRole,
    },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `SIGN-${label}-${token}`,
      name: `Signature guard ${label} loan`,
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
    },
  })
  await prisma.insurer.create({
    data: {
      id: creditLifeDisclosure.insurerId,
      tenantId,
      name: creditLifeDisclosure.insurerName,
      active: true,
    },
  })
  await prisma.insuranceProduct.create({
    data: {
      id: creditLifeDisclosure.productId,
      tenantId,
      code: `CL-SIGN-${label}-${token}`,
      name: creditLifeDisclosure.productName,
      type: "CREDIT_LIFE",
      premiumAmount: creditLifeDisclosure.monthlyPremiumCents / 100,
      sumAssured: creditLifeDisclosure.principalCents / 100,
      active: true,
      insurerId: creditLifeDisclosure.insurerId,
    },
  })
  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-${label}-${token}`,
      idNumber: `SIGNATURE-GUARD-ID-${label}-${token}`,
      firstName: "Synthetic",
      lastName: label,
      email: `signature-guard-${label}-${token}@example.invalid`,
      phone: "+27820000000",
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
      contentSha256: pasqSha256,
      extractionStatus: "skipped",
    },
  })
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: `APP-${label}-${token}`,
      clientId,
      productId,
      appliedAmount: 500_000,
      appliedTermDays: 30,
      status: "APPROVED",
      // Required from APPROVED onward by LoanApplication_repayment_method_lifecycle
      // EFT because this suite exercises no debit mandate. The DISBURSED updates
      // below inherit it.
      repaymentMethod: "EFT",
      approvedAt: countersignedAt,
      approvedById: officerId,
      creditLifeElection: creditLifeDisclosure.election,
      creditLifeProductId: creditLifeDisclosure.productId,
      creditLifeProductName: creditLifeDisclosure.productName,
      creditLifeInsurerId: creditLifeDisclosure.insurerId,
      creditLifeInsurerName: creditLifeDisclosure.insurerName,
      creditLifeMonthlyPremiumCents:
        creditLifeDisclosure.monthlyPremiumCents,
      creditLifeDisclosureVersion: creditLifeDisclosure.version,
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(creditLifeDisclosure),
      creditLifeDisclosureAcknowledgedAt:
        new Date("2026-07-24T07:55:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: clientId,
      pasqVersion: pasqEvidence.version,
      pasqGeneratedAt: generatedAt,
      pasqDocumentId,
      pasqDocumentSha256: pasqSha256,
      pasqEvidence,
      pasqEvidenceSha256: evidenceSha256,
      pasqAcknowledgedAt: signedAt,
      pasqAcknowledgedBy: clientId,
      pasqAcknowledgedSha256: pasqSha256,
      approvedPasqDocumentSha256: pasqSha256,
      agreementGeneratedAt: generatedAt,
      agreementDocumentId: `agreement-${applicationId}`,
      agreementDocumentSha256: agreementSha256,
      agreementSignedAt: signedAt,
      agreementSignedMethod: consumerSignedMethod,
      agreementSignedByUserId: null,
      agreementSignatureData: consumerSignatureData,
      agreementCountersignedAt: countersignedAt,
      agreementCountersignedById: officerId,
      agreementCountersignedByName: "Synthetic Officer",
      agreementCountersignedByEmail: providerSignerEmail,
      agreementCountersignatureData: providerSignatureData,
      agreementCountersignatureSha256: storedProviderSignatureSha256,
      agreementCountersignatureEnvelopeSha256: envelopeSha256,
      agreementCountersignedDocumentSha256: agreementSha256,
    },
  })
  return {
    tenantId,
    applicationId,
    officerId,
    creditLifeProductId: creditLifeDisclosure.productId,
    creditLifeInsurerId: creditLifeDisclosure.insurerId,
  }
}

suite("provider countersign database envelope gate", () => {
  it("rejects a disbursement transition without the consumer-bound envelope", async () => {
    const scenario = await createCountersignedApplication("missing", "missing")

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "DISBURSED",
        disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
      },
    })).rejects.toThrow(/exact tenant, consumer signature and agreement/i)
  })

  it("accepts the complete envelope at the immediate database gate and freezes both signatures", async () => {
    const scenario = await createCountersignedApplication(
      "complete",
      "valid",
    )
    const rollback = new Error("intentional rollback before deferred loan invariant")

    await expect(prisma.$transaction(async (tx) => {
      const transitioned = await tx.loanApplication.update({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        data: {
          status: "DISBURSED",
          disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
        },
        select: { status: true },
      })
      expect(transitioned.status).toBe("DISBURSED")
      throw rollback
    })).rejects.toBe(rollback)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { agreementSignatureData: "forged replacement" },
    })).rejects.toThrow(/immutable after provider countersign/i)

    const otherTenantId =
      `tenant_signature_guard_other_${randomUUID().replaceAll("-", "")}`
    await prisma.tenant.create({
      data: {
        id: otherTenantId,
        slug: otherTenantId,
        name: "Other synthetic tenant",
      },
    })
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "User"
      SET "tenantId" = ${otherTenantId}
      WHERE "id" = ${scenario.officerId}
    `)).rejects.toThrow(/foreign key constraint/i)

    await prisma.$executeRaw(Prisma.sql`
      UPDATE "User"
      SET "active" = FALSE
      WHERE "id" = ${scenario.officerId}
    `)
    const progressed = await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { decisionReason: "unrelated update after signer deactivation" },
    })
    expect(progressed.decisionReason).toBe(
      "unrelated update after signer deactivation",
    )
  })

  it.each([
    ["product", "InsuranceProduct", "creditLifeProductId"],
    ["insurer", "Insurer", "creditLifeInsurerId"],
  ] as const)(
    "rejects APPROVED to DISBURSED after the credit-life %s is deactivated",
    async (_label, table, idField) => {
      const scenario = await createCountersignedApplication(
        `inactive-${table}`,
        "valid",
      )
      await prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "active" = FALSE WHERE "id" = $1 AND "tenantId" = $2`,
        scenario[idField],
        scenario.tenantId,
      )

      await expect(prisma.loanApplication.update({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        data: {
          status: "DISBURSED",
          disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
        },
      })).rejects.toThrow(
        /active tenant-bound credit-life product and insurer/i,
      )
    },
  )

  it("serializes disbursement against concurrent credit-life deactivation", async () => {
    const scenario = await createCountersignedApplication(
      "concurrent-offer-deactivation",
      "valid",
    )
    let releaseDeactivation!: () => void
    let reportProductLock!: () => void
    const deactivationMayCommit = new Promise<void>((resolve) => {
      releaseDeactivation = resolve
    })
    const productRowIsLocked = new Promise<void>((resolve) => {
      reportProductLock = resolve
    })

    const deactivation = prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InsuranceProduct"
        SET "active" = FALSE
        WHERE "id" = ${scenario.creditLifeProductId}
          AND "tenantId" = ${scenario.tenantId}
      `)
      reportProductLock()
      await deactivationMayCommit
    })

    await productRowIsLocked
    try {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'")
        return tx.loanApplication.update({
          where: {
            id: scenario.applicationId,
            tenantId: scenario.tenantId,
          },
          data: {
            status: "DISBURSED",
            disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
          },
        })
      })).rejects.toThrow(/lock timeout|canceling statement/i)
    } finally {
      releaseDeactivation()
      await deactivation
    }

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        status: "DISBURSED",
        disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
      },
    })).rejects.toThrow(
      /active tenant-bound credit-life product and insurer/i,
    )
  })

  it("rejects a READONLY direct writer as provider countersigner", async () => {
    await expect(createCountersignedApplication(
      "readonly-provider",
      "valid",
      "READONLY",
    )).rejects.toThrow(/active authorised signer/i)
  })

  it.each([
    ["provider signature digest", "forged_signature" as const],
    ["consumer/provider envelope digest", "forged_envelope" as const],
    ["consumer signing method", "null_method" as const],
  ])("rejects a fabricated %s supplied by a direct writer", async (_label, mode) => {
    const scenario = await createCountersignedApplication(mode, mode)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "DISBURSED",
        disbursedAt: new Date("2026-07-24T08:15:00.000Z"),
      },
    })).rejects.toThrow(/exact tenant, consumer signature and agreement/i)
  })
})
