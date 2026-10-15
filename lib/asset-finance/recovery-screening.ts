import { normaliseName } from "@/lib/asset-finance/payout-checklist"

// The pure part of related-party screening for a remarketing sale: does the
// buyer equal, or appear in, any list a recovery must not sell to without a
// second approver? Loading the lists is the caller's job. The result carries
// kinds only, never a name or identifier: it is stored on the sale and written
// to the audit log. Names compare as normaliseName tokens (so punctuation and
// spacing do not hide a match); identifiers compare with everything but
// letters and digits stripped.
// UNTESTED: the list of screened parties needs the lender's compliance sign-off.

export type ScreeningKind = "BORROWER" | "RELATED_PARTY" | "STAFF" | "COI_DECLARATION"

export interface ScreeningBuyer {
  name: string
  identifier: string
}

export interface ScreeningCandidates {
  kind: ScreeningKind
  names: string[]
  identifiers: string[]
  /** Free text (COI details): matches when it contains the buyer's name or identifier as whole tokens. */
  freeText?: string[]
}

export interface ScreeningMatch {
  kind: ScreeningKind
  on: "NAME" | "IDENTIFIER"
}

export interface ScreeningResult {
  match: boolean
  matches: ScreeningMatch[]
}

/** Letters and digits only, upper case. */
export function normaliseIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
}

function tokens(value: string): string[] {
  return normaliseName(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token !== "")
}

/** Whether `needle` occurs in `haystack` as a run of whole tokens. */
function containsTokens(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true
  }
  return false
}

/** Whether a run of whole tokens concatenates to `identifier` (a registration number split by slashes or spaces). */
function containsIdentifier(haystack: string[], identifier: string): boolean {
  if (identifier === "") return false
  for (let start = 0; start < haystack.length; start++) {
    let joined = ""
    for (let end = start; end < haystack.length && joined.length < identifier.length; end++) {
      joined += haystack[end]
      if (joined === identifier) return true
    }
  }
  return false
}

export function screenBuyer(buyer: ScreeningBuyer, candidates: ScreeningCandidates[]): ScreeningResult {
  const name = tokens(buyer.name)
  const identifier = normaliseIdentifier(buyer.identifier)
  const matches: ScreeningMatch[] = []
  for (const candidate of candidates) {
    for (const candidateName of candidate.names) {
      if (name.length > 0 && tokens(candidateName).join(" ") === name.join(" ")) {
        matches.push({ kind: candidate.kind, on: "NAME" })
      }
    }
    for (const candidateIdentifier of candidate.identifiers) {
      if (identifier !== "" && normaliseIdentifier(candidateIdentifier) === identifier) {
        matches.push({ kind: candidate.kind, on: "IDENTIFIER" })
      }
    }
    for (const text of candidate.freeText ?? []) {
      const words = tokens(text)
      if (containsTokens(words, name)) matches.push({ kind: candidate.kind, on: "NAME" })
      if (containsIdentifier(words, identifier)) matches.push({ kind: candidate.kind, on: "IDENTIFIER" })
    }
  }
  return { match: matches.length > 0, matches }
}
