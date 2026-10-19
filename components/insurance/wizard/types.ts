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
  /** Headline price for display (rands): cheapest main-member band when the product is rated, else premiumAmount. */
  headlinePremium: number
  /** True when headlinePremium is a rate-table minimum and must read "From". */
  headlineIsFrom: boolean
  /** Cover (rands) of the cheapest band when headlineIsFrom, else null (use sumAssured). */
  headlineCover: number | null
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
