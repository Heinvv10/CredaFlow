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
