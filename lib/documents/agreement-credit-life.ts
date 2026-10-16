import type { LoanApplication } from "@prisma/client"
import { pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import type { generateCreditAgreementPdf } from "@/lib/pdf/creditAgreement"

type AgreementCreditLife = Parameters<typeof generateCreditAgreementPdf>[0]["creditLife"]

/**
 * The credit-life inputs for a credit agreement, read from the application's
 * stored election (Fair Score audit B6). A no-offer record prints "Credit
 * Life: Not offered"; an offer, accepted or declined, prints its election and
 * the acknowledged quotation's terms. Never inferred from absent evidence: a
 * declined offer must not read as "not offered". Throws rather than render an
 * NCA document from a record that does not verify.
 */
export function agreementCreditLifeFromRecord(application: LoanApplication): {
  creditLife: AgreementCreditLife
  creditLifeNotOffered: boolean
  elected: boolean
} {
  const record = verifyStoredCreditLifeDisclosure(application, {
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
  })
  if (!record.ok) {
    throw new Error("The credit agreement requires the intact credit-life election captured before the quotation.")
  }
  const elected = record.evidence.election === "ACCEPTED"
  if (!record.evidence.offered) return { creditLife: undefined, creditLifeNotOffered: true, elected }

  const pasq = application.pasqEvidence
  if (!pasqEvidenceIsIntact(pasq)) {
    throw new Error("The credit agreement requires the acknowledged quotation's credit-life terms.")
  }
  return {
    creditLife: {
      elected,
      productName: record.evidence.productName ?? "",
      insurerName: record.evidence.insurerName ?? "",
      monthlyPremiumCents: record.evidence.monthlyPremiumCents,
      premiumPeriods: pasq.creditLife.premiumPeriods,
      totalPremiumCents: pasq.creditLife.totalPremiumCents,
      billing: pasq.billing,
    },
    creditLifeNotOffered: false,
    elected,
  }
}
