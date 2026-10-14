import { Prisma } from "@prisma/client"
import { affordabilityCalculatorFingerprint, affordabilityContractFingerprint, type AffordabilityCalculatorEvidence } from "@/lib/affordability/snapshot"
import { createPasqEvidence, type PasqEvidence } from "@/lib/compliance/pasq"
import type { VerifiedCreditLifeEvidence } from "@/lib/insurance/credit-life-election.server"
import type { Solved } from "./deal-structure"
import { dueDateInstant, toScheduleRecord } from "./schedule-records"

export function assetCalculatorEvidence(
  solved: Extract<Solved, { ok: true }>,
  initiationFeeCents: number,
): AffordabilityCalculatorEvidence {
  const records = solved.result.rows.map(toScheduleRecord)
  const serviceFeesCents = records.reduce((sum, row) => sum + row.feesDue, 0) - initiationFeeCents
  const withoutHashes = {
    version: "loan-calculator-v3" as const,
    startDate: dueDateInstant(solved.startDate).toISOString(),
    principalCents: solved.result.financedAmountCents,
    totalInterestCents: records.reduce((sum, row) => sum + row.interestDue, 0),
    initiationFeeCents,
    serviceFeesCents,
    totalRepayableCents: records.reduce((sum, row) => sum + row.totalDue, 0),
    disbursementAmountCents: solved.result.financedAmountCents,
    recurringInstalmentCents: solved.result.baseInstalmentCents,
    schedule: records.map((row, index) => ({
      installmentNo: row.installmentNo,
      dueDate: dueDateInstant(solved.result.rows[index].dueDate).toISOString(),
      principalDueCents: row.principalDue,
      interestDueCents: row.interestDue,
      feesDueCents: row.feesDue,
      totalDueCents: row.totalDue,
      openingBalanceCents: solved.result.rows[index].openingBalanceCents,
      closingBalanceCents: solved.result.rows[index].closingBalanceCents,
    })),
  }
  return {
    ...withoutHashes,
    pricingFingerprint: affordabilityCalculatorFingerprint(withoutHashes),
    contractFingerprint: affordabilityContractFingerprint(withoutHashes),
  }
}

export function createAssetPasqEvidence(args: {
  tenantId: string
  applicationId: string
  clientId: string
  productId: string
  termDays: number
  generatedAt: Date
  solved: Extract<Solved, { ok: true }>
  initiationFeeCents: number
  creditLife: VerifiedCreditLifeEvidence
}): PasqEvidence {
  return createPasqEvidence({
    tenantId: args.tenantId,
    applicationId: args.applicationId,
    clientId: args.clientId,
    productId: args.productId,
    termDays: args.termDays,
    generatedAt: args.generatedAt,
    calculator: assetCalculatorEvidence(args.solved, args.initiationFeeCents),
    creditLife: {
      election: args.creditLife.election,
      productId: args.creditLife.productId,
      productName: args.creditLife.productName,
      insurerId: args.creditLife.insurerId,
      insurerName: args.creditLife.insurerName,
      monthlyPremiumCents: args.creditLife.monthlyPremiumCents,
      disclosureVersion: args.creditLife.version,
      disclosureSha256: args.creditLife.disclosureSha256,
    },
  })
}

export const pasqJson = (evidence: PasqEvidence): Prisma.InputJsonValue => evidence as unknown as Prisma.InputJsonValue
