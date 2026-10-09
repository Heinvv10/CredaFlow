import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PASQ_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/pasq-approval-guard-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { calculateLoan } from "@/lib/loan-calculator"
import { createAffordabilityCalculatorEvidence } from "@/lib/affordability/snapshot"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { createPasqEvidence } from "@/lib/compliance/pasq"

const suite = process.env.RUN_PASQ_GUARD_IT === "1" ? describe : describe.skip

async function createScenario(
  label: string,
  withDocument: boolean,
  termDays = 30,
) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_pasq_guard_${label}_${token}`
  const clientId = `client_pasq_guard_${label}_${token}`
  const productId = `product_pasq_guard_${label}_${token}`
  const applicationId = `application_pasq_guard_${label}_${token}`
  const officerId = `officer_pasq_guard_${label}_${token}`
  const documentId = `document_pasq_guard_${label}_${token}`
  const creditLifeProductId = `credit-life-${token}`
  const creditLifeInsurerId = `insurer-${token}`
  const documentSha256 = label.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)
  const generatedAt = new Date("2026-07-24T08:00:00.000Z")
  const creditLifeAcknowledgedAt = new Date("2026-07-24T07:55:00.000Z")
  const acknowledgedAt = new Date("2026-07-24T08:05:00.000Z")
  const creditLifeDisclosure = {
    version: "credit-life-election-v1" as const,
    election: "DECLINED" as const,
    principalCents: 500_000,
    termDays,
    monthlyPremiumCents: 2_250,
    productId: creditLifeProductId,
    productName: "Synthetic Credit Life",
    insurerId: creditLifeInsurerId,
    insurerName: "Synthetic Insurer",
  }
  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays,
    generatedAt,
    calculator: createAffordabilityCalculatorEvidence(calculateLoan({
      principal: 500_000,
      termDays,
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

  await prisma.tenant.create({
    data: {
      id: tenantId,
      slug: `pasq-guard-${label}-${token}`,
      name: `PASQ guard ${label}`,
    },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `PASQ-${label}-${token}`,
      name: `PASQ guard ${label} loan`,
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
      id: creditLifeInsurerId,
      tenantId,
      name: creditLifeDisclosure.insurerName,
      active: true,
    },
  })
  await prisma.insuranceProduct.create({
    data: {
      id: creditLifeProductId,
      tenantId,
      code: `CREDIT-LIFE-${label}-${token}`,
      name: creditLifeDisclosure.productName,
      type: "CREDIT_LIFE",
      premiumAmount: 22.5,
      sumAssured: 5_000,
      active: true,
      insurerId: creditLifeInsurerId,
    },
  })
  await prisma.user.create({
    data: {
      id: officerId,
      tenantId,
      email: `pasq-guard-officer-${label}-${token}@example.invalid`,
      name: "Synthetic Officer",
      password: "not-a-real-login",
      role: "LOAN_ADMIN",
    },
  })
  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-${label}-${token}`,
      idNumber: `PASQ-GUARD-ID-${label}-${token}`,
      firstName: "Synthetic",
      lastName: label,
      email: `pasq-guard-${label}-${token}@example.invalid`,
      phone: "+27820000000",
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
      appliedTermDays: termDays,
      status: "UNDER_REVIEW",
      creditLifeElection: creditLifeDisclosure.election,
      creditLifeProductId: creditLifeDisclosure.productId,
      creditLifeProductName: creditLifeDisclosure.productName,
      creditLifeInsurerId: creditLifeDisclosure.insurerId,
      creditLifeInsurerName: creditLifeDisclosure.insurerName,
      creditLifeMonthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      creditLifeDisclosureVersion: creditLifeDisclosure.version,
      creditLifeDisclosureSha256:
        createCreditLifeDisclosureSha256(creditLifeDisclosure),
      creditLifeDisclosureAcknowledgedAt: creditLifeAcknowledgedAt,
      creditLifeDisclosureAcknowledgedBy: clientId,
      pasqVersion: pasqEvidence.version,
      pasqGeneratedAt: generatedAt,
      pasqDocumentId: documentId,
      pasqDocumentSha256: documentSha256,
      pasqEvidence,
      pasqEvidenceSha256: evidenceSha256,
      pasqAcknowledgedAt: acknowledgedAt,
      pasqAcknowledgedBy: clientId,
      pasqAcknowledgedSha256: documentSha256,
    },
  })
  if (withDocument) {
    await prisma.clientDocument.create({
      data: {
        id: documentId,
        tenantId,
        clientId,
        docType: "FORM_20_PRE_AGREEMENT",
        fileUrl: `/api/applications/${applicationId}/pasq`,
        fileName: `pasq-${applicationId}.pdf`,
        fileSize: 4096,
        mimeType: "application/pdf",
        storagePath: `/tmp/pasq-${applicationId}.pdf`,
        contentSha256: documentSha256,
        extractionStatus: "skipped",
      },
    })
  }
  return {
    tenantId,
    clientId,
    productId,
    applicationId,
    officerId,
    documentId,
    documentSha256,
    creditLifeProductId,
    creditLifeInsurerId,
  }
}

suite("approved PASQ database guards", () => {
  it("rejects approval when the application-bound document metadata is absent", async () => {
    const scenario = await createScenario("missing_document", false)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/application-bound PASQ document(?: metadata)?/i)
  })

  it("rejects approval when nullable acknowledgement bindings would make the legacy CHECK evaluate to NULL", async () => {
    const scenario = await createScenario("null_acknowledgement_binding", true)
    await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        // The original acknowledgement constraint is conditional on the
        // acknowledgement digest. This exact combination therefore remains
        // structurally valid while UNDER_REVIEW and reproduces the reviewer
        // bypass against the approved-status CHECK.
        pasqAcknowledgedBy: null,
        pasqAcknowledgedSha256: null,
        approvedPasqDocumentSha256: null,
      },
    })

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: null,
      },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("rejects fabricated minimal PASQ JSON and an arbitrary digest", async () => {
    const scenario = await createScenario("fabricated_evidence", true)
    const fabricatedDigest = "e".repeat(64)
    await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        pasqEvidence: {
          version: "pasq-v2",
          tenantId: scenario.tenantId,
          applicationId: scenario.applicationId,
          clientId: scenario.clientId,
          productId: "fabricated-product",
          evidenceSha256: fabricatedDigest,
        },
        pasqEvidenceSha256: fabricatedDigest,
      },
    })

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("rejects approval without the application's explicit credit-life election", async () => {
    const scenario = await createScenario("missing_credit_life_election", true)
    await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        creditLifeElection: null,
        creditLifeProductId: null,
        creditLifeProductName: null,
        creditLifeInsurerId: null,
        creditLifeInsurerName: null,
        creditLifeMonthlyPremiumCents: null,
        creditLifeDisclosureVersion: null,
        creditLifeDisclosureSha256: null,
        creditLifeDisclosureAcknowledgedAt: null,
        creditLifeDisclosureAcknowledgedBy: null,
      },
    })

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(
      /active tenant-bound credit-life product and insurer|check constraint|approved_status_requires_pasq/i,
    )
  })

  it("rejects a staff actor recorded as the consumer credit-life acknowledger", async () => {
    const scenario = await createScenario("staff_credit_life_acknowledger", true)
    await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        creditLifeDisclosureAcknowledgedBy: scenario.officerId,
      },
    })

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(
      /active tenant-bound credit-life product and insurer|check constraint|approved_status_requires_pasq/i,
    )
  })

  it("rejects approval when PASQ credit-life evidence differs from the application", async () => {
    const scenario = await createScenario("mismatched_credit_life", true)
    await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { creditLifeProductName: "Mutated product name" },
    })

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(
      /credit-life product|check constraint|approved_status_requires_pasq/i,
    )
  })

  it("rejects approval against an inactive credit-life product", async () => {
    const scenario = await createScenario("inactive_credit_life", true)
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "InsuranceProduct"
      SET "active" = FALSE
      WHERE "id" = ${scenario.creditLifeProductId}
        AND "tenantId" = ${scenario.tenantId}
    `)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/active tenant-bound credit-life product and insurer/i)
  })

  it("rejects approval against an inactive credit-life insurer", async () => {
    const scenario = await createScenario("inactive_credit_life_insurer", true)
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "Insurer"
      SET "active" = FALSE
      WHERE "id" = ${scenario.creditLifeInsurerId}
        AND "tenantId" = ${scenario.tenantId}
    `)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/active tenant-bound credit-life product and insurer/i)
  })

  it("rejects a cross-tenant credit-life product reference", async () => {
    const scenario = await createScenario("cross_tenant_credit_life", true)
    const other = await createScenario("cross_tenant_credit_life_other", true)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { creditLifeProductId: other.creditLifeProductId },
    })).rejects.toThrow(/foreign key constraint/i)
  })

  it.each([31, 44])(
    "accepts a complete %i-day approval with every begun 30-day premium period",
    async (termDays) => {
      const scenario = await createScenario(
        `valid_term_${termDays}`,
        true,
        termDays,
      )

      const approved = await prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          status: "APPROVED",
          repaymentMethod: "EFT",
          approvedAt: new Date("2026-07-24T08:10:00.000Z"),
          approvedById: scenario.officerId,
          approvedPasqDocumentSha256: scenario.documentSha256,
        },
        select: { status: true },
      })
      expect(approved.status).toBe("APPROVED")
    },
  )

  it("rejects approval attributed to a user from another tenant", async () => {
    const scenario = await createScenario("cross_tenant_approver", true)
    const other = await createScenario("cross_tenant_approver_other", true)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: other.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/foreign key constraint/i)
  })

  it("serializes approval against concurrent PASQ document mutation", async () => {
    const scenario = await createScenario("concurrent_document", true)
    let releaseDocumentMutation!: () => void
    let reportDocumentLock!: () => void
    const documentMutationMayCommit = new Promise<void>((resolve) => {
      releaseDocumentMutation = resolve
    })
    const documentRowIsLocked = new Promise<void>((resolve) => {
      reportDocumentLock = resolve
    })

    const documentMutation = prisma.$transaction(async (tx) => {
      await tx.clientDocument.update({
        where: {
          id: scenario.documentId,
          tenantId: scenario.tenantId,
        },
        data: { deletedAt: new Date("2026-07-24T08:09:00.000Z") },
      })
      reportDocumentLock()
      await documentMutationMayCommit
    })

    await documentRowIsLocked
    try {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'")
        return tx.loanApplication.update({
          where: {
            id: scenario.applicationId,
            tenantId: scenario.tenantId,
          },
          data: {
            status: "APPROVED",
            repaymentMethod: "EFT",
            approvedAt: new Date("2026-07-24T08:10:00.000Z"),
            approvedById: scenario.officerId,
            approvedPasqDocumentSha256: scenario.documentSha256,
          },
        })
      })).rejects.toThrow(/lock timeout|canceling statement/i)
    } finally {
      releaseDocumentMutation()
      await documentMutation
    }

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt: new Date("2026-07-24T08:10:00.000Z"),
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/locked application-bound PASQ document/i)
  })

  it("accepts complete approval, freezes it, and permits only complete return-to-review invalidation", async () => {
    const scenario = await createScenario("valid", true)
    const approvedAt = new Date("2026-07-24T08:10:00.000Z")

    const approved = await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "APPROVED",
        repaymentMethod: "EFT",
        approvedAt,
        approvedById: scenario.officerId,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
      select: { status: true, approvedPasqDocumentSha256: true },
    })
    expect(approved).toEqual({
      status: "APPROVED",
      approvedPasqDocumentSha256: scenario.documentSha256,
    })

    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "ClientDocument"
      SET "deletedAt" = ${new Date("2026-07-24T08:11:00.000Z")}
      WHERE "id" = ${scenario.documentId}
        AND "tenantId" = ${scenario.tenantId}
    `)).rejects.toThrow(/PASQ document is immutable/i)

    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "ClientDocument"
      SET
        "uploadedByType" = 'client',
        "uploadedById" = ${scenario.clientId},
        "createdAt" = ${new Date("2026-07-24T08:12:00.000Z")}
      WHERE "id" = ${scenario.documentId}
        AND "tenantId" = ${scenario.tenantId}
    `)).rejects.toThrow(/PASQ document is immutable/i)

    const otherTenantId = `tenant_pasq_guard_other_${randomUUID().replaceAll("-", "")}`
    await prisma.tenant.create({
      data: {
        id: otherTenantId,
        slug: otherTenantId,
        name: "Other synthetic tenant",
      },
    })
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "Client"
      SET "tenantId" = ${otherTenantId}
      WHERE "id" = ${scenario.clientId}
    `)).rejects.toThrow(/foreign key constraint/i)
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "LoanProduct"
      SET "tenantId" = ${otherTenantId}
      WHERE "id" = ${scenario.productId}
    `)).rejects.toThrow(/foreign key constraint/i)
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "LoanApplication"
      SET "tenantId" = ${otherTenantId}
      WHERE "id" = ${scenario.applicationId}
    `)).rejects.toThrow(
      /application tenant|check constraint|PASQ evidence|application-bound PASQ/i,
    )

    // This row is APPROVED with no agreement, i.e. inside the signing-ceremony
    // window, where re-issuing a quotation is legal — so the trigger no longer
    // freezes the evidence here. Whatever evidence IS present must still be
    // internally exact, so a digest that no longer describes the object is
    // still refused, by the CHECK rather than by the trigger. The freeze itself
    // is asserted against an agreement-bearing row in
    // pasq-ceremony-guard-migration.integration.test.ts.
    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { pasqEvidenceSha256: "f".repeat(64) },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { creditLifeInsurerName: "Mutated insurer" },
    })).rejects.toThrow(/credit-life evidence is immutable after approval/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { approvedAt: new Date("2026-07-24T08:11:00.000Z") },
    })).rejects.toThrow(/approval attribution.*immutable after approval/i)

    const alternateOfficerId =
      `officer_pasq_guard_alternate_${randomUUID().replaceAll("-", "")}`
    await prisma.user.create({
      data: {
        id: alternateOfficerId,
        tenantId: scenario.tenantId,
        email: `${alternateOfficerId}@example.invalid`,
        name: "Alternate Synthetic Officer",
        password: "not-a-real-login",
        role: "LOAN_ADMIN",
      },
    })
    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { approvedById: alternateOfficerId },
    })).rejects.toThrow(/approval attribution.*immutable after approval/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        creditLifeDisclosureAcknowledgedAt:
          new Date("2026-07-24T07:54:00.000Z"),
      },
    })).rejects.toThrow(/credit-life evidence is immutable after approval/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "UNDER_REVIEW",
        repaymentMethod: null,
        approvedAt: null,
        approvedById: null,
        approvedPasqDocumentSha256: null,
        pasqVersion: null,
        pasqGeneratedAt: null,
        pasqDocumentId: null,
        pasqDocumentSha256: null,
        pasqEvidence: Prisma.DbNull,
        pasqEvidenceSha256: null,
        pasqAcknowledgedAt: null,
        pasqAcknowledgedBy: null,
        pasqAcknowledgedSha256: null,
        creditLifeMonthlyPremiumCents: 2_200,
      },
    })).rejects.toThrow(
      /only be invalidated by the explicit return-to-review transition/i,
    )

    const returned = await prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        status: "UNDER_REVIEW",
        repaymentMethod: null,
        approvedAt: null,
        approvedById: null,
        approvedPasqDocumentSha256: null,
        pasqVersion: null,
        pasqGeneratedAt: null,
        pasqDocumentId: null,
        pasqDocumentSha256: null,
        pasqEvidence: Prisma.DbNull,
        pasqEvidenceSha256: null,
        pasqAcknowledgedAt: null,
        pasqAcknowledgedBy: null,
        pasqAcknowledgedSha256: null,
      },
      select: { status: true, pasqDocumentId: true },
    })
    expect(returned).toEqual({
      status: "UNDER_REVIEW",
      pasqDocumentId: null,
    })
  })
})
