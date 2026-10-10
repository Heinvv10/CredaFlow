/**
 * Signing-ceremony re-sequencing guards (NCA s.92(1)).
 *
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PASQ_CEREMONY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/pasq-ceremony-guard-migration.integration.test.ts
 *
 * Unit tests mock Prisma and cannot observe a CHECK constraint or a trigger, so
 * every assertion here goes through a real database.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { calculateLoan } from "@/lib/loan-calculator"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  affordabilityDecisionSnapshotIsIntact,
  createAffordabilityCalculatorEvidence,
  createAffordabilityContractEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  createBureauDecisionEvidence,
  withAffordabilityContract,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
} from "@/lib/insurance/credit-life-election"
import { createPasqEvidence } from "@/lib/compliance/pasq"

const suite = process.env.RUN_PASQ_CEREMONY_IT === "1" ? describe : describe.skip

const PRINCIPAL_CENTS = 500_000
const TERM_DAYS = 30
const APPROVED_AT = new Date("2026-07-24T08:10:00.000Z")
const PASQ_GENERATED_AT = new Date("2026-07-24T08:20:00.000Z")
const PASQ_ACKNOWLEDGED_AT = new Date("2026-07-24T08:25:00.000Z")
const AGREEMENT_GENERATED_AT = new Date("2026-07-24T08:30:00.000Z")
const AGREEMENT_SIGNED_AT = new Date("2026-07-24T08:35:00.000Z")

/**
 * An UNDER_REVIEW application carrying a complete credit-life election but NO
 * quotation — the state the re-sequencing makes approvable.
 */
async function createCeremonyScenario(label: string, principalCents = PRINCIPAL_CENTS) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_ceremony_${label}_${token}`
  const clientId = `client_ceremony_${label}_${token}`
  const productId = `product_ceremony_${label}_${token}`
  const applicationId = `application_ceremony_${label}_${token}`
  const officerId = `officer_ceremony_${label}_${token}`
  const documentId = `document_ceremony_${label}_${token}`
  const creditLifeProductId = `credit-life-${token}`
  const creditLifeInsurerId = `insurer-${token}`
  const documentSha256 = token.slice(0, 2).padEnd(2, "a").repeat(32).slice(0, 64)

  const creditLifeDisclosure = {
    version: "credit-life-election-v1" as const,
    election: "DECLINED" as const,
    principalCents,
    termDays: TERM_DAYS,
    // Reg 3(1) maximum the guard pins: 0.45% of principal per month.
    monthlyPremiumCents: calculateCreditLifeMonthlyPremiumCents(principalCents),
    productId: creditLifeProductId,
    productName: "Synthetic Credit Life",
    insurerId: creditLifeInsurerId,
    insurerName: "Synthetic Insurer",
  }
  const disclosureSha256 = createCreditLifeDisclosureSha256(creditLifeDisclosure)

  const pasqEvidence = createPasqEvidence({
    tenantId,
    applicationId,
    clientId,
    productId,
    termDays: TERM_DAYS,
    generatedAt: PASQ_GENERATED_AT,
    calculator: createAffordabilityCalculatorEvidence(calculateLoan({
      principal: principalCents,
      termDays: TERM_DAYS,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0,
      initiationFeeMax: 0,
      monthlyServiceFee: 0,
      initiationFeePayment: "DEFERRED",
    }, PASQ_GENERATED_AT), PASQ_GENERATED_AT),
    creditLife: {
      election: creditLifeDisclosure.election,
      productId: creditLifeDisclosure.productId,
      productName: creditLifeDisclosure.productName,
      insurerId: creditLifeDisclosure.insurerId,
      insurerName: creditLifeDisclosure.insurerName,
      monthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
      disclosureSha256,
    },
  })

  await prisma.tenant.create({
    data: { id: tenantId, slug: `ceremony-${label}-${token}`, name: `Ceremony ${label}` },
  })
  await prisma.loanProduct.create({
    data: {
      id: productId,
      tenantId,
      code: `CEREMONY-${label}-${token}`,
      name: `Ceremony ${label} loan`,
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.15,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
    },
  })
  await prisma.insurer.create({
    data: { id: creditLifeInsurerId, tenantId, name: creditLifeDisclosure.insurerName, active: true },
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
      email: `ceremony-officer-${label}-${token}@example.invalid`,
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
      idNumber: `CEREMONY-ID-${label}-${token}`,
      firstName: "Synthetic",
      lastName: label,
      email: `ceremony-${label}-${token}@example.invalid`,
      phone: "+27820000000",
      monthlyIncome: 2_800_000,
      monthlyExpenses: 1_200_000,
    },
  })
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: `APP-${label}-${token}`,
      clientId,
      productId,
      appliedAmount: principalCents,
      appliedTermDays: TERM_DAYS,
      status: "UNDER_REVIEW",
      creditLifeElection: creditLifeDisclosure.election,
      creditLifeProductId,
      creditLifeProductName: creditLifeDisclosure.productName,
      creditLifeInsurerId,
      creditLifeInsurerName: creditLifeDisclosure.insurerName,
      creditLifeMonthlyPremiumCents: creditLifeDisclosure.monthlyPremiumCents,
      creditLifeDisclosureVersion: creditLifeDisclosure.version,
      creditLifeDisclosureSha256: disclosureSha256,
      creditLifeDisclosureAcknowledgedAt: new Date("2026-07-24T07:55:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: clientId,
    },
  })
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

  return {
    tenantId,
    clientId,
    productId,
    applicationId,
    officerId,
    documentId,
    documentSha256,
    pasqEvidence,
    where: { id: applicationId, tenantId },
  }
}

type Scenario = Awaited<ReturnType<typeof createCeremonyScenario>>

/** APPROVED with no quotation — ceremony state (a). */
async function approve(scenario: Scenario) {
  return prisma.loanApplication.update({
    where: scenario.where,
    data: {
      status: "APPROVED",
      approvedAt: APPROVED_AT,
      approvedById: scenario.officerId,
      repaymentMethod: "EFT",
    },
    select: { status: true, pasqDocumentId: true, approvedPasqDocumentSha256: true },
  })
}

/** Issue the quotation — ceremony state (b). */
async function issueQuotation(scenario: Scenario) {
  return prisma.loanApplication.update({
    where: scenario.where,
    data: {
      pasqVersion: scenario.pasqEvidence.version,
      pasqGeneratedAt: PASQ_GENERATED_AT,
      pasqDocumentId: scenario.documentId,
      pasqDocumentSha256: scenario.documentSha256,
      pasqEvidence: scenario.pasqEvidence as unknown as Prisma.InputJsonValue,
      pasqEvidenceSha256: scenario.pasqEvidence.evidenceSha256,
    },
    select: { pasqDocumentSha256: true, approvedPasqDocumentSha256: true },
  })
}

/**
 * Consumer acknowledgement — ceremony state (c). Mirrors BOTH writes the
 * production writer performs: the application transition AND the document
 * marking. The document write is load-bearing coverage — the bound-PASQ
 * trigger used to reject any post-approval document update, which silently
 * broke every acknowledgement while an application-only fixture stayed green.
 */
async function acknowledge(scenario: Scenario) {
  const application = await prisma.loanApplication.update({
    where: scenario.where,
    data: {
      pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT,
      pasqAcknowledgedBy: scenario.clientId,
      pasqAcknowledgedSha256: scenario.documentSha256,
      approvedPasqDocumentSha256: scenario.documentSha256,
    },
    select: { pasqAcknowledgedAt: true, approvedPasqDocumentSha256: true },
  })
  const documentMarked = await prisma.clientDocument.updateMany({
    where: { id: scenario.documentId, tenantId: scenario.tenantId },
    data: { signatureState: "acknowledged" },
  })
  if (documentMarked.count !== 1) {
    throw new Error("acknowledgement did not mark the PASQ document")
  }
  return application
}

async function generateAgreement(scenario: Scenario) {
  return prisma.loanApplication.update({
    where: scenario.where,
    data: {
      agreementGeneratedAt: AGREEMENT_GENERATED_AT,
      agreementDocumentId: `agreement_${scenario.applicationId}`,
      agreementDocumentSha256: "a".repeat(64),
    },
    select: { agreementGeneratedAt: true },
  })
}

suite("PASQ signing-ceremony database guards", () => {
  it("approves an application that has no quotation at all", async () => {
    // The whole point of the re-sequencing: NCA s.92(1) attaches the quotation
    // to entering into the agreement, not to the credit decision. On the
    // previous constraint this exact update was rejected outright.
    const scenario = await createCeremonyScenario("approve_without_pasq")

    await expect(approve(scenario)).resolves.toEqual({
      status: "APPROVED",
      pasqDocumentId: null,
      approvedPasqDocumentSha256: null,
    })
  })

  it("accepts app-built approval evidence with a bureau override and a drift-prone instalment", async () => {
    // Regression for the float/NUMERIC requiredNdi split: the app used to
    // compute Math.ceil(i * (pct / 100)), which lands one cent above the
    // guard's exact NUMERIC CEIL(i * pct / 100) whenever i is a multiple of
    // 10 — i.e. virtually every real instalment. Every earlier fixture used a
    // buffer of 100 (where both formulas agree), so only a real approval
    // against a real database could catch it. This installs evidence built by
    // the SAME production helpers the decide route uses.
    // R1,500 over 30 days reproduces the float-drift case exactly: the
    // recurring instalment lands on 186_900, inside a float-drift zone for a
    // 110% buffer.
    const DRIFT_PRINCIPAL_CENTS = 150_000
    const scenario = await createCeremonyScenario("evidence_install", DRIFT_PRINCIPAL_CENTS)
    const capturedAt = APPROVED_AT
    const calculation = calculateLoan({
      principal: DRIFT_PRINCIPAL_CENTS,
      termDays: TERM_DAYS,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.15,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED",
    }, capturedAt)
    const calculatorEvidence = createAffordabilityCalculatorEvidence(calculation, capturedAt)
    const instalment = calculatorEvidence.recurringInstalmentCents
    // The drift precondition itself: the legacy float formula must disagree
    // with the exact one for this instalment, or the scenario proves nothing.
    expect(Math.ceil(instalment * (110 / 100)))
      .toBe(Math.ceil((instalment * 110) / 100) + 1)
    const gate = evaluateAffordabilityGate({
      monthlyIncomeCents: 2_800_000,
      monthlyExpensesCents: 1_200_000,
      declaredDebtCents: 0,
      bureauObligationsCents: 0,
      proposedInstalmentCents: instalment,
      ndiBufferPct: 110,
    })
    expect(gate.blocked).toBe(false)
    const snapshot = createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt,
      capturedById: scenario.officerId,
      inputs: {
        monthlyIncomeCents: 2_800_000,
        monthlyExpensesCents: 1_200_000,
        applicationDebtCents: 0,
        clientDebtCents: 0,
        declaredDebtCents: 0,
        bureauObligationsCents: 0,
        proposedInstalmentCents: instalment,
        creditLifePremiumCents: 0,
        principalCents: DRIFT_PRINCIPAL_CENTS,
        termDays: TERM_DAYS,
        productId: scenario.productId,
        productType: "MICRO",
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        initiationFeeModel: "FLAT_PCT",
        initiationFeePct: 0.15,
        initiationFeeMaxCents: 100_000,
        monthlyServiceFeeCents: 6_900,
        initiationFeePayment: "DEFERRED",
        ndiBufferPct: 110,
      },
      applicationDebts: [],
      clientDebts: [],
      expenseEvidence: createAffordabilityExpenseEvidence({
        monthlyIncome: 2_800_000,
        monthlyExpenses: 1_200_000,
      }),
      bureauEvidence: createBureauDecisionEvidence({
        check: null,
        minimumScore: 450,
        blockAdverse: false,
        override: {
          reason: "Bureau integration not yet live; manual review completed.",
          byId: scenario.officerId,
          at: capturedAt,
        },
      }),
      calculation,
      calculationStartDate: capturedAt,
      outcome: {
        netDisposableIncomeCents: gate.ndi,
        ndiAfterLoanCents: gate.ndi - instalment,
        requiredNdiCents: gate.requiredNdi,
        isAffordable: !gate.blocked,
        reason: gate.reason ?? null,
      },
    })
    expect(affordabilityDecisionSnapshotIsIntact(snapshot)).toBe(true)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        status: "APPROVED",
        approvedAt: capturedAt,
        approvedById: scenario.officerId,
        repaymentMethod: "EFT",
        approvedAmount: DRIFT_PRINCIPAL_CENTS,
        approvedTermDays: TERM_DAYS,
        approvedRate: 0.05,
        totalExistingDebt: 0,
        netDisposableIncome: gate.ndi,
        affordabilityNDI: gate.ndi - instalment,
        affordabilityResult: withAffordabilitySnapshot(null, snapshot) as unknown as Prisma.InputJsonValue,
      },
      select: { status: true },
    })).resolves.toEqual({ status: "APPROVED" })
  })

  it("walks the full ceremony: approve, issue, acknowledge, generate", async () => {
    const scenario = await createCeremonyScenario("full_walk")

    await approve(scenario)
    await expect(issueQuotation(scenario)).resolves.toEqual({
      pasqDocumentSha256: scenario.documentSha256,
      // Pinned only at acknowledgement, never at issue.
      approvedPasqDocumentSha256: null,
    })
    await expect(acknowledge(scenario)).resolves.toEqual({
      pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT,
      approvedPasqDocumentSha256: scenario.documentSha256,
    })
    await expect(generateAgreement(scenario)).resolves.toEqual({
      agreementGeneratedAt: AGREEMENT_GENERATED_AT,
    })
  })

  it("accepts the ROUTE-SHAPED regeneration: contract REPLACED, old contract archived, anchor swapped", async () => {
    // The route's regeneration UPDATE lands the new anchor AND a replacement
    // affordability contract (old one pushed to contractHistory) in one
    // statement — the exact write contract_install_allowed must accept with a
    // NON-NULL OLD contract. Everything here is built by the same production
    // helpers the route uses; mocked tests cannot see this branch at all.
    const DRIFT_PRINCIPAL_CENTS = 150_000
    const scenario = await createCeremonyScenario("regen_contract", DRIFT_PRINCIPAL_CENTS)
    const capturedAt = APPROVED_AT
    const calculation = calculateLoan({
      principal: DRIFT_PRINCIPAL_CENTS,
      termDays: TERM_DAYS,
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.15,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED",
    }, capturedAt)
    const calculatorEvidence = createAffordabilityCalculatorEvidence(calculation, capturedAt)
    const instalment = calculatorEvidence.recurringInstalmentCents
    const gate = evaluateAffordabilityGate({
      monthlyIncomeCents: 2_800_000,
      monthlyExpensesCents: 1_200_000,
      declaredDebtCents: 0,
      bureauObligationsCents: 0,
      proposedInstalmentCents: instalment,
      ndiBufferPct: 110,
    })
    const approvalSnapshot = createAffordabilitySnapshot({
      stage: "APPROVAL",
      policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
      capturedAt,
      capturedById: scenario.officerId,
      inputs: {
        monthlyIncomeCents: 2_800_000,
        monthlyExpensesCents: 1_200_000,
        applicationDebtCents: 0,
        clientDebtCents: 0,
        declaredDebtCents: 0,
        bureauObligationsCents: 0,
        proposedInstalmentCents: instalment,
        creditLifePremiumCents: 0,
        principalCents: DRIFT_PRINCIPAL_CENTS,
        termDays: TERM_DAYS,
        productId: scenario.productId,
        productType: "MICRO",
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        initiationFeeModel: "FLAT_PCT",
        initiationFeePct: 0.15,
        initiationFeeMaxCents: 100_000,
        monthlyServiceFeeCents: 6_900,
        initiationFeePayment: "DEFERRED",
        ndiBufferPct: 110,
      },
      applicationDebts: [],
      clientDebts: [],
      expenseEvidence: createAffordabilityExpenseEvidence({
        monthlyIncome: 2_800_000,
        monthlyExpenses: 1_200_000,
      }),
      bureauEvidence: createBureauDecisionEvidence({
        check: null,
        minimumScore: 450,
        blockAdverse: false,
        override: {
          reason: "Bureau integration not yet live; manual review completed.",
          byId: scenario.officerId,
          at: capturedAt,
        },
      }),
      calculation,
      calculationStartDate: capturedAt,
      outcome: {
        netDisposableIncomeCents: gate.ndi,
        ndiAfterLoanCents: gate.ndi - instalment,
        requiredNdiCents: gate.requiredNdi,
        isAffordable: !gate.blocked,
        reason: gate.reason ?? null,
      },
    })
    const approvalStore = withAffordabilitySnapshot(null, approvalSnapshot)
    await prisma.loanApplication.update({
      where: scenario.where,
      data: {
        status: "APPROVED",
        approvedAt: capturedAt,
        approvedById: scenario.officerId,
        repaymentMethod: "EFT",
        approvedAmount: DRIFT_PRINCIPAL_CENTS,
        approvedTermDays: TERM_DAYS,
        approvedRate: 0.05,
        totalExistingDebt: 0,
        netDisposableIncome: gate.ndi,
        affordabilityNDI: gate.ndi - instalment,
        affordabilityResult: approvalStore as unknown as Prisma.InputJsonValue,
      },
    })

    // Quotation whose calculator shares the approval's PRICING (the contract
    // builder demands matching pricingFingerprints), dated at issue time.
    const pasqCalculator = createAffordabilityCalculatorEvidence(
      calculateLoan({
        principal: DRIFT_PRINCIPAL_CENTS,
        termDays: TERM_DAYS,
        productType: "MICRO",
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
        initiationFeeModel: "FLAT_PCT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100_000,
        monthlyServiceFee: 6_900,
        initiationFeePayment: "DEFERRED",
      }, PASQ_GENERATED_AT),
      PASQ_GENERATED_AT,
    )
    const pasqEvidence = createPasqEvidence({
      tenantId: scenario.tenantId,
      applicationId: scenario.applicationId,
      clientId: scenario.clientId,
      productId: scenario.productId,
      termDays: TERM_DAYS,
      generatedAt: PASQ_GENERATED_AT,
      calculator: pasqCalculator,
      creditLife: scenario.pasqEvidence.creditLife,
    })
    await prisma.loanApplication.update({
      where: scenario.where,
      data: {
        pasqVersion: pasqEvidence.version,
        pasqGeneratedAt: PASQ_GENERATED_AT,
        pasqDocumentId: scenario.documentId,
        pasqDocumentSha256: scenario.documentSha256,
        pasqEvidence: pasqEvidence as unknown as Prisma.InputJsonValue,
        pasqEvidenceSha256: pasqEvidence.evidenceSha256,
      },
    })
    await acknowledge(scenario)

    // Generation v1 — route shape: anchor + contract in ONE statement.
    const contractV1 = createAffordabilityContractEvidence(
      approvalSnapshot,
      AGREEMENT_GENERATED_AT,
      { documentSha256: scenario.documentSha256, calculator: pasqCalculator },
    )
    const storeWithContractV1 = withAffordabilityContract(approvalStore, contractV1)
    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementGeneratedAt: AGREEMENT_GENERATED_AT,
        agreementDocumentId: `agreement_${scenario.applicationId}_v1`,
        agreementDocumentSha256: "a".repeat(64),
        affordabilityResult: storeWithContractV1 as unknown as Prisma.InputJsonValue,
      },
      select: { agreementDocumentId: true },
    })).resolves.toEqual({ agreementDocumentId: `agreement_${scenario.applicationId}_v1` })

    // Regeneration — the replacement contract archives v1 into history and the
    // anchor swaps, again in ONE statement. The DB guard must accept this
    // exact write with a NON-NULL OLD contract.
    const REGENERATED_AT = new Date("2026-07-24T08:33:00.000Z")
    const contractV2 = createAffordabilityContractEvidence(
      approvalSnapshot,
      REGENERATED_AT,
      { documentSha256: scenario.documentSha256, calculator: pasqCalculator },
    )
    const storeWithContractV2 = withAffordabilityContract(storeWithContractV1, contractV2)
    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementGeneratedAt: REGENERATED_AT,
        agreementDocumentId: `agreement_${scenario.applicationId}_v2`,
        agreementDocumentSha256: "b".repeat(64),
        affordabilityResult: storeWithContractV2 as unknown as Prisma.InputJsonValue,
      },
      select: { agreementDocumentSha256: true },
    })).resolves.toEqual({ agreementDocumentSha256: "b".repeat(64) })
  })

  it("permits superseding an UNSIGNED agreement artifact in place (regeneration)", async () => {
    // A template correction must be able to replace the unsigned draft
    // without tearing down the ceremony: the consumer's acknowledgement
    // stands, only the artifact the consumer will SIGN changes. The DB was
    // built for this — the guard's contract/anchor rules require only that
    // the anchor is never RETRACTED and nothing is signed yet.
    const scenario = await createCeremonyScenario("regenerate_unsigned")
    await approve(scenario)
    await issueQuotation(scenario)
    await acknowledge(scenario)
    await generateAgreement(scenario)

    const REGENERATED_AT = new Date("2026-07-24T08:32:00.000Z")
    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementGeneratedAt: REGENERATED_AT,
        agreementDocumentId: `agreement_${scenario.applicationId}_v2`,
        agreementDocumentSha256: "b".repeat(64),
      },
      select: { agreementDocumentSha256: true },
    })).resolves.toEqual({ agreementDocumentSha256: "b".repeat(64) })

    // Retiring the superseded draft document row is equally permitted — the
    // freeze triggers bind PASQ documents, not unsigned agreement drafts.
    await prisma.clientDocument.create({
      data: {
        id: `agreement_doc_${scenario.applicationId}`,
        tenantId: scenario.tenantId,
        clientId: scenario.clientId,
        docType: "CREDIT_AGREEMENT",
        fileUrl: `/api/documents/agreement_doc_${scenario.applicationId}/view`,
        fileName: "credit-agreement-old.pdf",
        fileSize: 4096,
        mimeType: "application/pdf",
        storagePath: `/tmp/agreement-${scenario.applicationId}.pdf`,
        contentSha256: "a".repeat(64),
        extractionStatus: "skipped",
      },
    })
    await expect(prisma.clientDocument.updateMany({
      where: { id: `agreement_doc_${scenario.applicationId}`, tenantId: scenario.tenantId },
      data: { deletedAt: REGENERATED_AT },
    })).resolves.toEqual({ count: 1 })
  })

  it("refuses to pin the ceremony digest before the consumer has acknowledged", async () => {
    // Correction #4: in the pre-agreement window an unacknowledged row must
    // carry approvedPasqDocumentSha256 = NULL. Allowing it to be set early is
    // what let the column claim an acknowledgement that never happened.
    const scenario = await createCeremonyScenario("digest_before_ack")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: { approvedPasqDocumentSha256: scenario.documentSha256 },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("refuses an acknowledgement that leaves the ceremony digest NULL", async () => {
    // The other half of correction #4: the column must never be satisfiable by
    // NULL in a state that claims an acknowledgement.
    const scenario = await createCeremonyScenario("ack_without_digest")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT,
        pasqAcknowledgedBy: scenario.clientId,
        pasqAcknowledgedSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("refuses a half-written acknowledgement in the ceremony window", async () => {
    // The three-valued-logic bypass the sibling constraints satisfy vacuously.
    const scenario = await createCeremonyScenario("partial_ack")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: { pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("refuses an acknowledgement attributed to anyone but the consumer", async () => {
    const scenario = await createCeremonyScenario("staff_ack")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT,
        pasqAcknowledgedBy: scenario.officerId,
        pasqAcknowledgedSha256: scenario.documentSha256,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/check constraint|approved_status_requires_pasq/i)
  })

  it("refuses to generate an agreement before a quotation exists", async () => {
    const scenario = await createCeremonyScenario("agreement_without_pasq")
    await approve(scenario)

    await expect(generateAgreement(scenario)).rejects.toThrow(
      /check constraint|approved_status_requires_pasq|application-bound PASQ/i,
    )
  })

  it("allows an unsigned agreement draft beside an issued, unacknowledged PASQ", async () => {
    const scenario = await createCeremonyScenario("agreement_without_ack")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(generateAgreement(scenario)).resolves.toEqual({
      agreementGeneratedAt: AGREEMENT_GENERATED_AT,
    })
  })

  it("refuses to sign a prepared agreement without the PASQ acknowledgement", async () => {
    const scenario = await createCeremonyScenario("signature_without_ack")
    await approve(scenario)
    await issueQuotation(scenario)
    await generateAgreement(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementSignedAt: AGREEMENT_SIGNED_AT,
        agreementSignedMethod: "portal",
        agreementSignatureData: "synthetic-consumer-signature",
      },
    })).rejects.toThrow(
      /check constraint|approved_status_requires_pasq/i,
    )
  })

  it("accepts PASQ acknowledgement and agreement signature in one packet transaction", async () => {
    const scenario = await createCeremonyScenario("combined_packet_signing")
    await approve(scenario)
    await issueQuotation(scenario)
    await generateAgreement(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        pasqAcknowledgedAt: AGREEMENT_SIGNED_AT,
        pasqAcknowledgedBy: scenario.clientId,
        pasqAcknowledgedSha256: scenario.documentSha256,
        approvedPasqDocumentSha256: scenario.documentSha256,
        agreementSignedAt: AGREEMENT_SIGNED_AT,
        agreementSignedMethod: "portal",
        agreementSignatureData: "synthetic-consumer-signature",
      },
      select: {
        pasqAcknowledgedAt: true,
        agreementSignedAt: true,
      },
    })).resolves.toEqual({
      pasqAcknowledgedAt: AGREEMENT_SIGNED_AT,
      agreementSignedAt: AGREEMENT_SIGNED_AT,
    })
    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { signatureState: "acknowledged" },
    })).resolves.toEqual({ count: 1 })
  })

  it("still refuses a standalone staff acknowledgement after packet preparation", async () => {
    const scenario = await createCeremonyScenario("standalone_ack_after_packet")
    await approve(scenario)
    await issueQuotation(scenario)
    await generateAgreement(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        pasqAcknowledgedAt: PASQ_ACKNOWLEDGED_AT,
        pasqAcknowledgedBy: scenario.clientId,
        pasqAcknowledgedSha256: scenario.documentSha256,
        approvedPasqDocumentSha256: scenario.documentSha256,
      },
    })).rejects.toThrow(/PASQ evidence is immutable after approval/i)
  })

  it("still freezes a bound PASQ document's content and rejects any state but acknowledged", async () => {
    // The acknowledged-marking allowance must not have loosened anything else:
    // content stays immutable and no other signature state may be written.
    const scenario = await createCeremonyScenario("bound_doc_immutable")
    await approve(scenario)
    await issueQuotation(scenario)

    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { contentSha256: "b".repeat(64) },
    })).rejects.toThrow(/PASQ document is immutable/)
    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { signatureState: "signed" },
    })).rejects.toThrow(/only accepts the acknowledged signature state/)
    // The whole-row freeze still covers provenance fields the
    // deny-list rewrite would have silently unfrozen — verification state is
    // legal evidence on a bound quotation.
    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { verified: true },
    })).rejects.toThrow(/PASQ document is immutable/)
    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { verificationNote: "tampered" },
    })).rejects.toThrow(/PASQ document is immutable/)
    // The acknowledged marking is not free-standing either: without the bound
    // application actually holding the consumer acknowledgement, the flag is
    // manufactured evidence and must be refused.
    await expect(prisma.clientDocument.updateMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { signatureState: "acknowledged" },
    })).rejects.toThrow(/requires the bound application to hold the consumer acknowledgement/)
    await expect(prisma.clientDocument.deleteMany({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
    })).rejects.toThrow(/PASQ document is immutable/)
  })

  it("freezes PASQ evidence once an agreement exists", async () => {
    const scenario = await createCeremonyScenario("freeze_on_agreement")
    await approve(scenario)
    await issueQuotation(scenario)
    await acknowledge(scenario)
    await generateAgreement(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: { pasqAcknowledgedAt: new Date("2026-07-24T09:00:00.000Z") },
    })).rejects.toThrow(/PASQ evidence is immutable after approval/i)
  })

  it("rejects the freeze-anchor attack on a signed agreement", async () => {
    // This exact sequence SUCCEEDED against the previous attempt, which froze
    // PASQ evidence on `agreementGeneratedAt` alone: null that one nullable
    // column, the ceremony reopens, and the acknowledged quotation can be
    // rewritten underneath a contract the consumer has already signed.
    const scenario = await createCeremonyScenario("freeze_anchor_attack")
    await approve(scenario)
    await issueQuotation(scenario)
    await acknowledge(scenario)
    await generateAgreement(scenario)
    await prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementSignedAt: AGREEMENT_SIGNED_AT,
        agreementSignedMethod: "portal",
        agreementSignatureData: "synthetic-consumer-signature",
      },
    })

    // Step 1 — retract the generation stamp on its own. The chronology CHECK
    // catches this even though the PASQ trigger's column list would not fire.
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "LoanApplication"
      SET "agreementGeneratedAt" = NULL
      WHERE "id" = ${scenario.applicationId}
        AND "tenantId" = ${scenario.tenantId}
    `)).rejects.toThrow(/agreement_chronology|check constraint/i)

    // Step 1' — retract every agreement artefact at once, which satisfies
    // chronology. The anchor-retraction guard catches it.
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "LoanApplication"
      SET "agreementGeneratedAt" = NULL,
          "agreementSignedAt" = NULL,
          "agreementCountersignedAt" = NULL
      WHERE "id" = ${scenario.applicationId}
        AND "tenantId" = ${scenario.tenantId}
    `)).rejects.toThrow(
      /may not be retracted while the application is approved|check constraint/i,
    )

    // Step 2 — rewrite the acknowledged quotation directly. Re-pointing the
    // document digest is caught by the document lock, which runs first.
    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: { pasqDocumentSha256: "b".repeat(64) },
    })).rejects.toThrow(
      /locked application-bound PASQ document|PASQ evidence is immutable after approval/i,
    )

    // Step 2' — rewrite evidence the document lock does not inspect, so the
    // rejection can only come from the freeze itself.
    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: { pasqEvidenceSha256: "c".repeat(64) },
    })).rejects.toThrow(/PASQ evidence is immutable after approval/i)

    // The row is intact: the consumer's signed contract still names the exact
    // quotation they acknowledged.
    const after = await prisma.loanApplication.findUniqueOrThrow({
      where: scenario.where,
      select: {
        agreementGeneratedAt: true,
        agreementSignedAt: true,
        pasqDocumentSha256: true,
        pasqAcknowledgedSha256: true,
        approvedPasqDocumentSha256: true,
      },
    })
    expect(after).toEqual({
      agreementGeneratedAt: AGREEMENT_GENERATED_AT,
      agreementSignedAt: AGREEMENT_SIGNED_AT,
      pasqDocumentSha256: scenario.documentSha256,
      pasqAcknowledgedSha256: scenario.documentSha256,
      approvedPasqDocumentSha256: scenario.documentSha256,
    })
  })

  it("rejects a signature stamped on an agreement that was never generated", async () => {
    const scenario = await createCeremonyScenario("signature_without_generation")
    await approve(scenario)
    await issueQuotation(scenario)
    await acknowledge(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        agreementSignedAt: AGREEMENT_SIGNED_AT,
        agreementSignedMethod: "portal",
        agreementSignatureData: "synthetic-consumer-signature",
      },
    })).rejects.toThrow(/agreement_chronology|check constraint/i)
  })

  it("still refuses a quotation bound to a retired document", async () => {
    const scenario = await createCeremonyScenario("retired_document")
    await approve(scenario)
    await prisma.clientDocument.update({
      where: { id: scenario.documentId, tenantId: scenario.tenantId },
      data: { deletedAt: new Date("2026-07-24T08:15:00.000Z") },
    })

    await expect(issueQuotation(scenario)).rejects.toThrow(
      /application-bound PASQ document/i,
    )
  })

  it("clears the ceremony on return to review", async () => {
    const scenario = await createCeremonyScenario("return_to_review")
    await approve(scenario)
    await issueQuotation(scenario)
    await acknowledge(scenario)

    await expect(prisma.loanApplication.update({
      where: scenario.where,
      data: {
        status: "UNDER_REVIEW",
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
        repaymentMethod: null,
      },
      select: { status: true, pasqDocumentId: true },
    })).resolves.toEqual({ status: "UNDER_REVIEW", pasqDocumentId: null })
  })

  it("enforces at most ONE live acknowledgement link per application at the database layer", async () => {
    // The mint helper is transactional, but the invariant must survive any
    // future caller that is not: two live tokens means a link sent to a
    // since-corrected number could still acknowledge the quotation.
    const scenario = await createCeremonyScenario("one_active_link")
    const base = {
      tenantId: scenario.tenantId,
      applicationId: scenario.applicationId,
      clientId: scenario.clientId,
      documentSha256: "a".repeat(64),
      channel: "SMS",
      sentTo: "+27820000001",
      expiresAt: new Date(Date.now() + 60_000),
      createdById: scenario.officerId,
    }
    await prisma.pasqAcknowledgementToken.create({ data: { ...base, tokenHash: "b".repeat(64) } })
    await expect(
      prisma.pasqAcknowledgementToken.create({ data: { ...base, tokenHash: "c".repeat(64) } }),
    ).rejects.toMatchObject({ code: "P2002" })
    // Invalidating the live one reopens the slot.
    await prisma.pasqAcknowledgementToken.updateMany({
      where: { tenantId: scenario.tenantId, applicationId: scenario.applicationId, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    })
    await prisma.pasqAcknowledgementToken.create({ data: { ...base, tokenHash: "d".repeat(64) } })
    await prisma.pasqAcknowledgementToken.deleteMany({ where: { tenantId: scenario.tenantId } })
  })
})
