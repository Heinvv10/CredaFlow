import { isNcaJurisdiction } from "@/lib/jurisdiction/active"

/**
 * The consumer evidence an approval needs, by the application's disclosure regime
 * (LoanApplication.disclosureRegime, stamped from the instance's jurisdiction).
 *
 * An NCA_PASQ application needs all of it. A KEY_FACTS application (a jurisdiction without
 * the National Credit Act) does not: the NCA s81 reckless-lending assessment and the
 * affordability declaration it rests on are South African law, a credit-life election is
 * made under the South African Credit Life Insurance Regulations, and the bureaus the
 * lender has integrations for are South African. Everything else an approval checks
 * (KYC, the submission snapshot, the affordability gate, screening, credit checks, the
 * approval matrix) applies to both. Used by decide-application and by the locked
 * re-verification inside its transaction, so the two cannot drift.
 */
export interface ApprovalEvidenceRules {
  /** A recorded credit-life election and its disclosure. */
  creditLifeElection: boolean
  /** The client's affordability declaration. */
  affordabilityDeclaration: boolean
  /** The NCA s81 reckless-lending assessment. */
  recklessLendingAssessment: boolean
  /** A current check with a South African bureau (or a reasoned override). */
  bureauCheck: boolean
  /**
   * A configured screening provider. The reverse of the four above: South Africa lets a lender run without one (the
   * bureau check is its identity-risk evidence), but a key-facts loan has no bureau, so with no provider it would be
   * approved with no PEP or sanctions check at all. The simulated provider counts where the deployment permits it.
   */
  screeningProvider: boolean
}

export function approvalEvidenceRules(application: { disclosureRegime?: string | null }): ApprovalEvidenceRules {
  const nca = application.disclosureRegime !== "KEY_FACTS"
  return { creditLifeElection: nca, affordabilityDeclaration: nca, recklessLendingAssessment: nca, bureauCheck: nca, screeningProvider: !nca }
}

/**
 * Whether the decision engine may attest affordability itself (DecisionEngineConfig.keyFactsInstantApproval). Never under the
 * NCA: s81 asks a person to assess the consumer. The CHECK LoanApplication_automated_affordability says the same.
 */
export function automatedAffordabilityAllowedUnder(regime: string | null | undefined): boolean {
  return regime === "KEY_FACTS"
}

/** The regime the database stamps on an application created now (guardLoanApplicationDisclosureRegime's insert trigger). */
export function newApplicationRegime(): "NCA_PASQ" | "KEY_FACTS" {
  return isNcaJurisdiction() ? "NCA_PASQ" : "KEY_FACTS"
}

/**
 * The one basis for "may this application be offered credit life": its own stamped regime, or for one not created yet the
 * regime it will get. Not the instance's jurisdiction alone: an NCA_PASQ application that pre-dates a switch stays under
 * the NCA, and guardLoanApplicationCreditLifeOffer still judges it against the product rows, so it must keep being offered.
 */
export function creditLifeOfferableUnder(regime?: string | null): boolean {
  return approvalEvidenceRules({ disclosureRegime: regime ?? newApplicationRegime() }).creditLifeElection
}

/**
 * Credit life on a KEY_FACTS loan: none. It is billed under South African regulations (a
 * premium per month of cover, a South African insurer product), so a key-facts loan is priced
 * as a no-offer disclosure is: declined, premium zero. The same billing helper runs, so the
 * instalment approved is the instalment every later document prints.
 */
export const KEY_FACTS_CREDIT_LIFE = { election: "DECLINED", offered: false, monthlyPremiumCents: 0 } as const

/** Why a KEY_FACTS application cannot be approved on cover, or null. */
export function keyFactsCreditLifeRefusal(application: { disclosureRegime?: string | null; creditLifeElection?: string | null }): string | null {
  return application.disclosureRegime === "KEY_FACTS" && application.creditLifeElection === "ACCEPTED"
    ? "Credit life cannot be added to a loan outside the National Credit Act's jurisdiction: decline the cover or return the application to draft."
    : null
}
