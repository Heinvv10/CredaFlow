import type { Headline } from "@/lib/insurance/headline-premium"
export type { Client } from "@/components/wizard/types"

export interface Advisor {
  id: string
  name: string | null
  email: string
}

export interface Product {
  id: string
  name: string
  type: string
  premiumAmount: number
  /** What quoting can actually produce for this product (lib/insurance/headline-premium.ts). */
  headline: Headline
  sumAssured: number
  commissionRate: number
  active: boolean
  code: string
  /** The underwriter the lender configured on the product (Settings → Products), if any. */
  insurerName: string | null
}

// Step 1 form data — all amounts in RANDS (user-entered)
export interface PolicyDraftData {
  clientId: string
  advisorId: string
  productId: string
  type: string
  sumAssured: string
  premiumAmount: string
  commissionRate: string
  startDate: string
  insurer: string
  linkedLoanRef: string
  // Motor risk fields
  vehicleRegNumber: string
  vehicleValue: string
  vehicleUse: string
  // Property risk fields
  propertyAddress: string
  constructionType: string
  propertyValue: string
}

export type Step = 1 | 2 | 3
