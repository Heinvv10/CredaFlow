// How a lender's wording reaches a renderer. A renderer given an
// AppliedWording replaces only the family's editable clauses (before any CPA
// appendix is added to them), appends the additional terms after its last
// protected clause, and prints the mark. Without one it prints the starter
// with the legacy TenantConfig watermark: sample renders and tests only —
// issuance always passes the selected version (./issuance.ts).
import type { AssetTemplateContent } from "./content"
import { fillTokens } from "./tokens"

/** What every page carries: a preview, a synthetic demo approval, or a lender's legal approval (nothing). */
export type WordingMark = "DRAFT" | "SYNTHETIC_DEMO" | "NONE"

export interface AppliedWording {
  templateKey: string
  content: AssetTemplateContent
  mark: WordingMark
}

export interface PrintedClause {
  heading: string
  text: string
}

/** The lender's text for an editable clause with its tokens filled, or `fallback` without wording. */
export function editableClauseText(wording: AppliedWording | undefined, id: string, tokens: Readonly<Record<string, string>>, fallback: string): string {
  const text = wording?.content.clauses[id]
  return text === undefined ? fallback : fillTokens(text, tokens)
}

/** The lender's additional terms, tokens filled. */
export function additionalTerms(wording: AppliedWording | undefined, tokens: Readonly<Record<string, string>>): PrintedClause[] {
  return (wording?.content.additionalTerms ?? []).map((t) => ({ heading: fillTokens(t.heading, tokens), text: fillTokens(t.text, tokens) }))
}

/** The identity tokens every family offers. */
export function identityTokens(lender: { legalName: string; tradingName?: string; registeredOfficeLines: readonly string[] }, reference: string): Record<string, string> {
  return {
    "lender.legalName": lender.legalName,
    ...(lender.tradingName !== undefined ? { "lender.tradingName": lender.tradingName } : {}),
    "lender.registeredOffice": lender.registeredOfficeLines.join(", "),
    "agreement.reference": reference,
  }
}

/** The watermark: the template's mark, or the legacy flag without wording. */
export function wordingWatermark(wording: AppliedWording | undefined, legalWordingApproved: boolean): WordingMark {
  if (wording) return wording.mark
  return legalWordingApproved ? "NONE" : "DRAFT"
}
