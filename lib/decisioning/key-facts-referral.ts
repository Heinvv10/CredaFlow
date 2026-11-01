import type { DecisionFacts } from "./facts"
import { automatedAffordabilityAllowedUnder } from "@/lib/non-nca-documents/regime-evidence"
import { REASON_SCORE_BELOW_CUTOFF } from "./decide"
import type { Node, RuleDef, Verdict } from "./types"

export interface KeyFactsReferral {
  reasonCode: "NO_BUREAU" | "MISSING_FACT"
  note: string
}

/** The facts a rule compares (isNull / notNull test for a missing fact on purpose, so they do not count). */
function comparedFields(node: Node, into: Set<keyof DecisionFacts>) {
  if ("field" in node) {
    if (node.op !== "isNull" && node.op !== "notNull") into.add(node.field)
    return
  }
  for (const child of [...(node.all ?? []), ...(node.any ?? [])]) comparedFields(child, into)
}

/**
 * Why the engine must hand a KEY_FACTS application to staff instead of approving it for want of evidence, or null.
 *
 * A rule never fires on a fact that is not known, so a rule set written for a bureau passes every bureau rule
 * for an application nobody bureau-checked. South Africa's staff approval path refuses a missing bureau
 * check itself; a key-facts application has no bureau, so nothing downstream would, and the engine would approve a
 * person nobody assessed. A key-facts application is therefore referred when it has no bureau check, and
 * when any fact a rule compares is missing. Pure.
 */
export function keyFactsReferral(input: {
  regime: string | null | undefined
  bureauCheckId: string | null
  facts: DecisionFacts
  rules: readonly RuleDef[]
}): KeyFactsReferral | null {
  if (input.regime !== "KEY_FACTS") return null
  if (!input.bureauCheckId) {
    return { reasonCode: "NO_BUREAU", note: "A key-facts application has no bureau check, so the engine cannot approve it or decline it on a score; staff must decide." }
  }
  const fields = new Set<keyof DecisionFacts>()
  for (const rule of input.rules) comparedFields(rule.when, fields)
  const missing = [...fields].filter((field) => input.facts[field] === null)
  if (missing.length > 0) {
    return { reasonCode: "MISSING_FACT", note: `A rule compares a fact that is not known (${missing.join(", ")}), so the engine cannot approve; staff must decide.` }
  }
  return null
}

/**
 * The verdict the engine acts on for a key-facts application `keyFactsReferral` applies to. An approval becomes a referral,
 * and so does a scorecard decline with no bureau check: that score is built on missing facts, so it says nothing about the
 * person. Whatever the decision, the grade goes: it was scored on facts nobody checked, and a grade on the row takes the
 * application out of the approval matrix's `ungraded` rule and into risk pricing. A rule's decline on known facts, and a
 * rule's referral, keep their decision. Pure.
 */
export function withKeyFactsReferral(verdict: Verdict, input: Parameters<typeof keyFactsReferral>[0]): { verdict: Verdict; note: string | null } {
  const referral = keyFactsReferral(input)
  if (!referral) return { verdict, note: null }
  const ungraded = { ...verdict, riskGrade: null, gradeRank: null, score: null, pricingTier: null }
  const declinedOnScore = referral.reasonCode === "NO_BUREAU" && verdict.reasonCodes.includes(REASON_SCORE_BELOW_CUTOFF)
  if (verdict.decision !== "APPROVE" && !declinedOnScore) return { verdict: ungraded, note: null }
  return { verdict: { ...ungraded, decision: "REFER", reasonCodes: [referral.reasonCode], declineCategory: null }, note: referral.note }
}

export interface KeyFactsAttestationInput {
  regime: string | null | undefined
  /** The lender's setting (DecisionEngineConfig.keyFactsInstantApproval). */
  allowed: boolean
  trigger: string
  facts: DecisionFacts
}

/** Why the engine must not attest affordability for this approval, or null. */
function attestationRefusal(input: KeyFactsAttestationInput): { reasonCode: string; note: string } | null {
  if (input.allowed !== true) {
    return { reasonCode: "KEY_FACTS_INSTANT_APPROVAL_OFF", note: "The lender has not switched on instant approval of key-facts applications; staff must decide." }
  }
  if (input.trigger !== "DIGITAL_SUBMISSION" || input.facts.channel !== "PORTAL") {
    return { reasonCode: "NOT_A_DIGITAL_SUBMISSION", note: "The engine attests affordability only for an application the client submitted digitally; staff must decide." }
  }
  if (input.facts.affordabilityGatePasses !== true || input.facts.expensesBelowMinimum !== false) {
    return { reasonCode: "AFFORDABILITY_NOT_ATTESTED", note: "The engine cannot attest this application's affordability; staff must decide." }
  }
  return null
}

/**
 * The last step of an approval of a key-facts application (after withKeyFactsReferral, so a bureau check is on file and every
 * compared fact is known): the engine attests affordability in place of a person, or refers. An approval it cannot attest
 * becomes a referral, keeping the grade: this applicant was bureau-checked. Only an application whose regime allows an automated
 * attestation is touched, so an NCA_PASQ verdict passes through and still needs a person's s81 assessment in the staff path.
 * The database holds the same rule (guardLoanApplicationAutomatedAffordability). Pure.
 */
export function withKeyFactsAttestation(verdict: Verdict, input: KeyFactsAttestationInput): { verdict: Verdict; note: string | null; attested: boolean } {
  if (!automatedAffordabilityAllowedUnder(input.regime) || verdict.decision !== "APPROVE") return { verdict, note: null, attested: false }
  const refusal = attestationRefusal(input)
  if (!refusal) return { verdict, note: null, attested: true }
  return { verdict: { ...verdict, decision: "REFER", reasonCodes: [refusal.reasonCode], declineCategory: null }, note: refusal.note, attested: false }
}
