import type { ReferenceRateBasis } from "@prisma/client"
import type { NcaAssetContractType } from "../../nca-caps"

export interface NcaAssetScheduleRow {
  installmentNo: number
  dueDate: string
  principalCents: number
  interestCents: number
  feesCents: number
  totalCents: number
  closingBalanceCents: number
}

export interface NcaAssetDocumentData {
  /** TenantConfig.assetFinanceLegalWordingApproved; false prints the DRAFT watermark and subtitle. */
  legalWordingApproved: boolean
  reference: string
  documentDate: Date
  contractType: NcaAssetContractType
  lender: { legalName: string; ncrNumber: string; registeredOfficeLines: string[] }
  borrower: { name: string; identityNumber: string; addressLines: string[] }
  asset: { description: string; serialNumber: string }
  pricing: {
    cashPriceCents: number
    depositCents: number
    principalCents: number
    annualRate: string
    /** How the rate is set: FIXED, or a reference rate plus `rateMargin`, resolved to `reference` on the start date. */
    rateBasis: ReferenceRateBasis
    rateMargin: string | null
    reference: { effectiveDate: string; rate: string } | null
    initiationFeeCents: number
    monthlyServiceFeeCents: number
    creditLifePremiumCents: number
    instalmentCents: number
    balloonCents: number
    totalInterestCents: number
    totalCostOfCreditCents: number
    totalRepayableCents: number
  }
  schedule: NcaAssetScheduleRow[]
}
