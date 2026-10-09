import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { calculateLoan, type LoanCalcInput } from "@/lib/loan-calculator"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityContractEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  type AffordabilityDecisionInputs,
} from "@/lib/affordability/snapshot"
import {
  createDebitMandateEvidence,
  debitMandateContractTerms,
  debitMandateEvidenceSha256,
  sha256DebitMandateValue,
} from "@/lib/compliance/debit-mandate"

type ApplicationContractFixtureArgs = {
  applicationId: string
  productId: string
  officerId: string
  pricing: LoanCalcInput
  quotePresentedAt: Date
  agreementEstablishedAt: Date
  acceptedPasqDocumentSha256: string
}

export function createApplicationContractFixture(
  args: ApplicationContractFixtureArgs,
) {
  const calculation = calculateLoan(args.pricing, args.quotePresentedAt)
  const proposedInstalmentCents = calculation.monthlyInstalment
  const inputs: AffordabilityDecisionInputs = {
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents,
    principalCents: args.pricing.principal,
    termDays: args.pricing.termDays,
    productId: args.productId,
    interestRatePm: args.pricing.interestRatePm,
    interestModel: args.pricing.interestModel,
    initiationFeeModel: args.pricing.initiationFeeModel,
    initiationFeePct: args.pricing.initiationFeePct,
    initiationFeeMaxCents: args.pricing.initiationFeeMax,
    monthlyServiceFeeCents: args.pricing.monthlyServiceFee,
    productType: args.pricing.productType,
    initiationFeePayment: args.pricing.initiationFeePayment ?? "DEFERRED",
    ndiBufferPct: 100,
  }
  const expenses = createAffordabilityExpenseEvidence({
    grossMonthlyIncome: 2_000_000,
    monthlyIncome: inputs.monthlyIncomeCents,
    monthlyExpenses: inputs.monthlyExpensesCents,
    expenseBreakdown: {
      id: `expenses_${args.applicationId}`,
      updatedAt: args.quotePresentedAt,
      housing: 400_000,
      transport: 150_000,
      food: 150_000,
      education: 0,
      insurance: 50_000,
      clothing: 0,
      entertainment: 0,
      medical: 50_000,
      other: 0,
      belowMleJustification: null,
    },
  })
  const netDisposableIncomeCents =
    inputs.monthlyIncomeCents - inputs.monthlyExpensesCents
  const approval = createAffordabilitySnapshot({
    stage: "APPROVAL",
    policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
    capturedAt: args.quotePresentedAt,
    capturedById: args.officerId,
    inputs,
    applicationDebts: [],
    clientDebts: [],
    expenseEvidence: expenses,
    bureauEvidence: null,
    calculation,
    calculationStartDate: args.quotePresentedAt,
    outcome: {
      netDisposableIncomeCents,
      ndiAfterLoanCents:
        netDisposableIncomeCents - proposedInstalmentCents,
      requiredNdiCents: proposedInstalmentCents,
      isAffordable: true,
      reason: null,
    },
  })
  const contract = createAffordabilityContractEvidence(
    approval,
    args.agreementEstablishedAt,
    {
      documentSha256: args.acceptedPasqDocumentSha256,
      calculator: approval.calculator,
    },
  )
  return {
    calculation,
    affordabilityResult: {
      schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
      approval,
      contract,
    },
  }
}

type SignedDebitMandateFixtureArgs = {
  tenantId: string
  clientId: string
  applicationId: string
  agreementSignedAt: Date
  affordabilityResult: unknown
  pasqEvidence: unknown
  bankStatementAccountTypeLabel?: string
}

export async function createSignedDebitMandateFixture(
  args: SignedDebitMandateFixtureArgs,
) {
  const token = randomUUID().replaceAll("-", "")
  const preparedAt = new Date(args.agreementSignedAt.getTime() + 60_000)
  const signedAt = new Date(preparedAt.getTime() + 60_000)
  const statementVerifiedAt = new Date(preparedAt.getTime() - 60_000)
  const statementId = `bank_statement_mandate_${token}`
  const statementSha256 = "d".repeat(64)
  const mandateDocumentId = `debit_mandate_${token}`
  const mandateDocumentSha256 = "e".repeat(64)
  const collectionReference = `DM-${token}`
  const signatureData = "Synthetic customer debit mandate"
  const contract = debitMandateContractTerms(
    args.affordabilityResult,
    args.pasqEvidence,
  )
  const bankDetails = {
    bankName: "First National Bank",
    branchCode: "250655",
    accountNumber: "62012345678",
    accountType: "CHEQUE" as const,
  }

  await prisma.client.update({
    where: {
      id: args.clientId,
      tenantId: args.tenantId,
    },
    data: {
      bankName: bankDetails.bankName,
      bankBranchCode: bankDetails.branchCode,
      bankAccountNumber: bankDetails.accountNumber,
      accountType: bankDetails.accountType,
    },
  })
  await prisma.clientDocument.create({
    data: {
      id: statementId,
      tenantId: args.tenantId,
      clientId: args.clientId,
      docType: "BANK_STATEMENT",
      fileUrl: `/test-fixtures/${statementId}.pdf`,
      fileName: `${statementId}.pdf`,
      fileSize: 4096,
      mimeType: "application/pdf",
      storagePath: `/tmp/${statementId}.pdf`,
      contentSha256: statementSha256,
      extractionStatus: "completed",
      extractionResult: {
        fields: {
          bankName: { value: bankDetails.bankName },
          branchCode: { value: bankDetails.branchCode },
          accountNumber: { value: bankDetails.accountNumber },
          accountType: {
            value: args.bankStatementAccountTypeLabel ?? "Current account",
          },
        },
      },
      validationMismatch: false,
      verified: true,
      verifiedAt: statementVerifiedAt,
    },
  })
  await prisma.clientDocument.create({
    data: {
      id: mandateDocumentId,
      tenantId: args.tenantId,
      clientId: args.clientId,
      docType: "DEBIT_MANDATE",
      fileUrl: `/api/applications/${args.applicationId}/debit-mandate`,
      fileName: `debit-mandate-${args.applicationId}.pdf`,
      fileSize: 4096,
      mimeType: "application/pdf",
      storagePath: `/tmp/debit-mandate-${args.applicationId}.pdf`,
      contentSha256: mandateDocumentSha256,
      extractionStatus: "skipped",
      verified: true,
      verifiedAt: signedAt,
      signatureState: "signed",
      signedAt,
    },
  })

  const evidence = createDebitMandateEvidence({
    applicationId: args.applicationId,
    clientId: args.clientId,
    collectionReference,
    contractFingerprint: contract.contractFingerprint,
    bankDetails,
    bankStatement: {
      documentId: statementId,
      documentSha256: statementSha256,
      verifiedAt: statementVerifiedAt.toISOString(),
    },
    terms: contract.evidence,
    preparedAt,
  })

  return {
    debitMandatePreparedAt: preparedAt,
    debitMandateReference: collectionReference,
    debitMandateDraftSha256: "f".repeat(64),
    debitMandateEvidence: evidence,
    debitMandateEvidenceSha256: debitMandateEvidenceSha256(evidence),
    debitMandateSignedAt: signedAt,
    debitMandateSignedMethod: "portal",
    debitMandateSignatureData: signatureData,
    debitMandateSignatureSha256: sha256DebitMandateValue(signatureData),
    debitMandateDocumentId: mandateDocumentId,
    debitMandateDocumentSha256: mandateDocumentSha256,
  }
}
