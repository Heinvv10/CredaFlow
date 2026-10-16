import type { Client } from "@/components/wizard/types"

export type WizardMode = "staff" | "portal"

export interface ApplicationProduct {
  /** Selects the NCA initiation-fee regime — lib/loan/nca-fee-cap.ts. */
  productType: string | null
  id: string
  name: string
  code: string
  minAmount: number           // rand (DB stores cents; loaders divide by 100)
  maxAmount: number           // rand (DB stores cents; loaders divide by 100)
  minTermDays: number
  maxTermDays: number
  interestRate: number        // alias for interestRatePm; kept for Step 2 display
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number    // cents
  monthlyServiceFee: number   // cents
}

export interface ApplicationWizardData {
  // Step 1
  clientId: string
  // Step 2
  productId: string
  appliedAmount: string       // rand string ("5000" / "5000.00")
  appliedTermDays: string     // numeric string
  purpose: string
  purposeDetails: string
  // Purpose category code (legacy form's Select dropdown). The API forwards
  // this to LoanApplication.loanPurposeCategory. Populated by Step 2 dropdown
  // in T6 if surfaced, else stays "" and the API stores it as NULL (see
  // app/api/applications/route.ts: `data.loanPurposeCategory || null`).
  loanPurposeCategory: string
  // PO funding only (lib/applications/po-funding.ts): the purchase order the
  // advance funds. Required by Step 2 and by prepareApplicationFields.
  poNumber: string
  poBuyerName: string
  poDocumentId: string
  // Step 3 — computed but persisted snapshot.
  // The fee lines are carried alongside interest so the cost summary FOOTS:
  // principal + totalInterest + initiationFee + serviceFees === totalRepayable.
  // Without them the screen showed only interest, leaving the fee difference
  // unexplained on the same page where staff certify the NCA §92 quotation.
  monthlyInstalment: string
  /** Instalment 1 — carries a DEFERRED initiation fee, so it can exceed the
   *  level instalment. Shown separately so the §92 quotation states what the
   *  consumer is actually debited first. */
  firstInstalment: string
  totalInterest: string
  initiationFee: string
  serviceFees: string
  totalRepayable: string
  affordabilityFlag: "" | "PASS" | "MARGINAL" | "FAIL"
  // Step 4 — compliance checkboxes (existing fields preserved)
  creditLifeElection: "" | "ACCEPTED" | "DECLINED"
  creditLifeDisclosureAcknowledged: boolean
  pasqAcknowledged: boolean
  affordabilityDeclared: boolean
  recklessLendingConfirmed: boolean // matches API key recklessLendingConfirmed
  submitForReview: boolean
}

export const EMPTY_APPLICATION_WIZARD_DATA: ApplicationWizardData = {
  clientId: "",
  productId: "", appliedAmount: "", appliedTermDays: "",
  purpose: "", purposeDetails: "", loanPurposeCategory: "",
  poNumber: "", poBuyerName: "", poDocumentId: "",
  monthlyInstalment: "", firstInstalment: "", totalInterest: "", initiationFee: "", serviceFees: "", totalRepayable: "",
  affordabilityFlag: "",
  creditLifeElection: "",
  creditLifeDisclosureAcknowledged: false,
  pasqAcknowledged: false,
  affordabilityDeclared: false, recklessLendingConfirmed: false,
  submitForReview: false,
}

// Clearing the Step-3 snapshot whenever a calculation INPUT changes — that is
// the CLIENT (Step 1: their income/expenses/debt give the NDI) and the product,
// amount and term (Step 2). All four feed the Step 3 effect.
//
// Step 3 recomputes in a useEffect that only runs while that step is mounted,
// but "Edit" on the review screen can jump 4 → 1 or 4 → 2 and back without ever
// mounting it. Without this, changing the amount from R2,000 to R20,000 — or
// swapping to a client with a far smaller NDI — leaves the OLD cost of credit
// and the OLD affordability flag on screen, directly above the NCA §92
// "quotation issued to client" and §81 affordability-declaration checkboxes.
//
// Blanking `affordabilityFlag` is what makes this safe rather than cosmetic:
// validateStep3Affordability treats an empty flag as "run the affordability
// check before continuing", so the wizard cannot be submitted on a stale
// snapshot — the user is forced back through Step 3 to recompute.
// Typed, so a mistyped key is a compile error rather than a silently-ignored
// spread at the patch() call sites.
export const INVALIDATED_AFFORDABILITY: Partial<ApplicationWizardData> = {
  monthlyInstalment: "",
  firstInstalment: "",
  totalInterest: "",
  initiationFee: "",
  serviceFees: "",
  totalRepayable: "",
  affordabilityFlag: "" as const,
  creditLifeDisclosureAcknowledged: false,
  recklessLendingConfirmed: false,
}

export type ApplicationWizardStep = 1 | 2 | 3 | 4

export const APPLICATION_WIZARD_STEP_LABELS = [
  "Client",
  "Loan parameters",
  "Affordability",
  "Review",
] as const

export type { Client }
