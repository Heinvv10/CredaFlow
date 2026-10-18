// A template preview: the lender's own identity and a clearly synthetic,
// server-built deal of the template's variant, rendered by the same trusted
// renderers issuance uses, always with the DRAFT mark. A preview is never
// issued, stored or signable.
import type { LenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { leaseScheduleView } from "../../lease-view"
import { priceLease } from "../../lease-pricing"
import { createAssetPasqEvidence } from "../../nca-evidence"
import { solveNcaDealStructure } from "../../nca-structure"
import type { AnyDealDocumentData, DealDocumentData } from "../deal-document-data"
import type { LeaseDocumentTerms } from "../lease/lease-document-data"
import { renderNcaAssetAgreement } from "../nca/agreement-pdf"
import type { NcaAssetDocumentData } from "../nca/types"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal.fixture"
import type { AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"

type PreviewLender = Pick<LenderIdentity, "legalName" | "tradingName" | "companyRegNumber" | "ncrNumber" | "registeredOfficeLines">

function leaseTerms(contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE", cpa: boolean): LeaseDocumentTerms {
  const fml = contractType === "FULL_MAINTENANCE_LEASE"
  const priced = priceLease({
    cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
    startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
    maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065" } : null, vatRateTenThousandths: 1500,
  })
  return {
    contractType,
    terms: {
      rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
      maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" } : null,
      usage: fml ? { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 } : null,
    },
    schedule: leaseScheduleView(priced, "0.1500"), endDate: "2029-12-31",
    cpaApplies: cpa, cpaRule: cpa ? "CPA_JURISTIC_UNDER_THRESHOLD" : "CPA_JURISTIC_OVER_THRESHOLD",
  }
}

function ncaData(lender: PreviewLender, contractType: "INSTALMENT_SALE" | "FINANCE_LEASE"): NcaAssetDocumentData {
  const asset = { cashPriceExclVatCents: 100_000_000, vatCents: 15_000_000 }
  const terms = {
    depositCents: 15_000_000, tradeInCents: 0, financedFeesCents: 120_750, balloonCents: 20_000_000, preset: "MONTHLY" as const,
    weights: Array.from({ length: 36 }, () => 1), firstDueDate: "2027-01-31", vatDeferralPeriodIndex: null,
    rate: { basis: "PRIME" as const, fixedRate: null, margin: "0.0125" },
  }
  const rate = { annualRate: "0.1175", reference: { effectiveDate: "2026-09-01", rate: "0.105" } }
  const solved = solveNcaDealStructure(asset, terms, rate, "2026-12-31")
  if (!solved.ok) throw new Error(solved.error)
  const noOffer = { version: "credit-life-no-offer-v1" as const, election: "DECLINED" as const, principalCents: solved.result.financedAmountCents, termDays: solved.termDays }
  const evidence = createAssetPasqEvidence({
    tenantId: "preview", applicationId: "preview", clientId: "preview", productId: "preview", termDays: solved.termDays,
    generatedAt: new Date("2026-12-31T08:00:00.000Z"), solved, initiationFeeCents: terms.financedFeesCents,
    creditLife: { ...noOffer, offered: false, productId: null, productName: null, insurerId: null, insurerName: null, monthlyPremiumCents: 0, disclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer) },
  })
  const c = evidence.calculator
  return {
    legalWordingApproved: false, reference: "PREVIEW-NCA-0001", documentDate: new Date("2026-12-31T08:00:00.000Z"), contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: { name: "SAMPLE Consumer (synthetic)", identityNumber: "0000000000000", addressLines: ["1 Sample Street", "Sampletown", "0000"] },
    asset: { description: "2026 SAMPLE Loader (synthetic)", serialNumber: "SAMPLESERIAL0001" },
    pricing: {
      cashPriceCents: asset.cashPriceExclVatCents + asset.vatCents, depositCents: terms.depositCents, principalCents: c.principalCents, annualRate: rate.annualRate,
      rateBasis: "PRIME", rateMargin: "0.0125", reference: rate.reference, initiationFeeCents: c.initiationFeeCents,
      monthlyServiceFeeCents: Math.round(c.serviceFeesCents / c.schedule.length), creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents,
      instalmentCents: evidence.billing.recurringPaymentCents, balloonCents: terms.balloonCents, totalInterestCents: c.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    schedule: evidence.billing.schedule.map((r) => ({
      installmentNo: r.installmentNo, dueDate: sastCalendarDate(new Date(r.dueDate)), principalCents: r.principalDueCents,
      interestCents: r.interestDueCents, feesCents: r.feesDueCents, totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  }
}

function dealData(lender: PreviewLender, key: string): AnyDealDocumentData {
  const base = syntheticDealDocumentData({ reference: "PREVIEW-0001", lender })
  switch (key) {
    case "af.isa.commercial": return { ...base, isaCpaApplies: false }
    case "af.isa.cpa": return { ...base, isaCpaApplies: true }
    case "af.lease.operating.commercial": return { ...base, lease: leaseTerms("OPERATING_LEASE", false) }
    case "af.lease.operating.cpa": return { ...base, lease: leaseTerms("OPERATING_LEASE", true) }
    case "af.lease.fml.commercial": return { ...base, lease: leaseTerms("FULL_MAINTENANCE_LEASE", false) }
    case "af.lease.fml.cpa": return { ...base, lease: leaseTerms("FULL_MAINTENANCE_LEASE", true) }
    case "af.suretyship.nca": return { ...base, ncaApplies: true }
    default: return base satisfies DealDocumentData
  }
}

/** The preview PDF of `content` for template `templateKey` under `lender`'s identity. */
export async function renderTemplatePreview(templateKey: string, content: AssetTemplateContent, lender: PreviewLender): Promise<Buffer> {
  const key = parseTemplateKey(templateKey)
  if (!key) throw new RangeError(`Not an asset-finance template: ${templateKey}`)
  const wording = { templateKey, content, mark: "DRAFT" as const }
  if (key.family.family === "af.nca") {
    return renderNcaAssetAgreement(ncaData(lender, key.variant === "finance_lease" ? "FINANCE_LEASE" : "INSTALMENT_SALE"), wording)
  }
  const data = dealData(lender, templateKey)
  const surety = data.entity ? data.sureties[0]?.clientId ?? "" : ""
  return (await renderDealDocument(data, key.family.document, surety, wording)).bytes
}
