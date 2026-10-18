// What lender wording may contain (SPEC.md §2). Run on every draft, preview,
// approval and issuance, so stored content that fails today's rules is never
// approved or printed. Semantic limits a machine cannot check are the
// approver's attestation, not this file's.
import { winAnsiSafe } from "@/lib/pdf/executed-agreement"
import { additionalTermNumber, editableClauses, MAX_ADDITIONAL_TERMS, parseTemplateKey, STARTER_REVISIONS, takesLenderText, type AssetTemplateKey } from "./families"
import { parseContent, type AssetTemplateContent } from "./content"
import { ASSET_TEMPLATE_TOKENS, hasStrayBraces, tokensIn } from "./tokens"

export interface ContentProblem {
  /** "clauses.insurance", "additionalTerms.0.text", "content" */
  field: string
  message: string
}

const MONEY = /(?:\bR|\bZAR|\bUSD|\bEUR|\bGBP|[$€£¥])\s*\d|\d\s*(?:rands?|ZAR|USD|EUR|GBP)\b|\brands?\b|\bZAR/i
const RATE = /[%‰]|\bper\s*(?:cent|mille)\b|\bpercent(?:age)?\b|\bbasis[\s-]+points?\b|\bbps\b/i
// Every dotted number is a clause number and must exist: lender text holds no other figures.
const DOTTED_NUMBER = /\d+(?:\.\d+)+/g
// A word longer than this, or a heading longer than MAX_HEADING, would run past the page edge.
const MAX_WORD = 30
const MAX_HEADING = 50
// Lender text may not override, vary or waive protected content, nor create a
// charge: those are system terms (SPEC.md §2). Matched as whole words.
const OVERRIDING = /\b(notwithstanding|despite|in place of|instead of|amend(?:s|ed|ing|ment|ments)?|var(?:y|ies|ied|ying|iation|iations)|supersed(?:e|es|ed|ing)|(?:does|do|shall|will) not apply|waiv(?:e|es|ed|er|ing)|fees?|charges?|penalt(?:y|ies))\b/i
const CLAUSE_REFERENCE = /\bclauses?\s+(\d+(?:\.\d+)?)((?:\s*(?:,|and|or|to)\s*\d+(?:\.\d+)?)*)/gi

function textProblems(field: string, text: string, limits: { min: number; max: number }, key: AssetTemplateKey, required: readonly string[], citable: ReadonlySet<string>): ContentProblem[] {
  const out: ContentProblem[] = []
  const add = (message: string) => out.push({ field, message })
  const trimmed = text.trim()
  if (trimmed.length < limits.min) add(trimmed.length === 0 ? "This text is required and cannot be left out" : `Write at least ${limits.min} characters`)
  if (text.length > limits.max) add(`At most ${limits.max} characters`)
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) add("Use plain text: tabs and control characters are not allowed")
  if (text.split("\n").some((line) => winAnsiSafe(line) !== line)) add("Contains characters the document fonts cannot print")
  if (MONEY.test(text)) add("Amounts of money come only from the deal's figures; remove the amount")
  if (RATE.test(text)) add("Rates and percentages come only from the deal's figures; remove the rate")
  const overriding = text.match(OVERRIDING)
  if (overriding) add(`"${overriding[0]}": lender text may not override, vary or waive the protected terms or create a fee, charge or penalty`)
  if (hasStrayBraces(text)) add("A token is written {{name}}; remove the stray brace")
  const allowed = new Set<string>(key.family.tokens)
  for (const token of tokensIn(text)) {
    if (!(token in ASSET_TEMPLATE_TOKENS) || !allowed.has(token)) add(`{{${token}}} is not a token this document supports`)
  }
  // The purchaser's domicilium is the notices clause's own (7.12), nowhere else.
  if (field !== "clauses.notices" && tokensIn(text).includes("purchaser.domicilium")) add("{{purchaser.domicilium}} is used only in the notices clause")
  for (const token of required) {
    if (!tokensIn(text).includes(token)) add(`Must contain {{${token}}}`)
  }
  const cited = new Set<string>()
  for (const match of text.matchAll(CLAUSE_REFERENCE)) for (const n of [match[1], ...(match[2].match(/\d+(?:\.\d+)?/g) ?? [])]) cited.add(n)
  for (const match of text.matchAll(DOTTED_NUMBER)) cited.add(match[0])
  for (const n of cited) if (!citable.has(n)) add(`Clause ${n} does not exist in this document`)
  // A heading is bounded by its own length (MAX_HEADING); body text by word.
  if (!field.endsWith(".heading") && text.split(/\s+/).some((word) => word.length > MAX_WORD)) add(`A word may be at most ${MAX_WORD} characters, or it would run off the page`)
  return out
}

/** Every problem with `content` for template `templateKey`; empty when it may be saved, previewed, approved and printed. */
export function contentProblems(templateKey: string, content: AssetTemplateContent): ContentProblem[] {
  const key = parseTemplateKey(templateKey)
  if (!key) return [{ field: "content", message: "Not an asset-finance template" }]
  const out: ContentProblem[] = []
  if (content.templateKey !== templateKey) out.push({ field: "content", message: "This wording belongs to a different document" })
  if (!STARTER_REVISIONS.includes(content.starterRevision)) out.push({ field: "content", message: "Unknown starter revision" })
  // Protected clauses, and this version's own additional terms, may be cited.
  const citable = new Set([...key.family.protectedClauses(key.variant), ...content.additionalTerms.map((_, i) => additionalTermNumber(key.family, key.variant, i))])
  const expected = editableClauses(key).map((c) => c.id).sort()
  const given = Object.keys(content.clauses).sort()
  if (expected.join("|") !== given.join("|")) out.push({ field: "clauses", message: `This document's editable clauses are exactly: ${expected.join(", ") || "none"}` })
  for (const clause of editableClauses(key)) {
    const text = content.clauses[clause.id]
    if (typeof text === "string") out.push(...textProblems(`clauses.${clause.id}`, text, { min: 20, max: 6000 }, key, clause.requiredTokens, citable))
  }
  if (!takesLenderText(key) && content.additionalTerms.length > 0) {
    out.push({ field: "additionalTerms", message: "This document takes no additional terms: its wording is the protected starter, approved for your lender" })
  }
  if (content.additionalTerms.length > MAX_ADDITIONAL_TERMS) out.push({ field: "additionalTerms", message: `At most ${MAX_ADDITIONAL_TERMS} additional terms` })
  content.additionalTerms.forEach((term, i) => {
    out.push(...textProblems(`additionalTerms.${i}.heading`, term.heading, { min: 3, max: MAX_HEADING }, key, [], citable))
    if (term.heading.includes("\n")) out.push({ field: `additionalTerms.${i}.heading`, message: "A heading is one line" })
    out.push(...textProblems(`additionalTerms.${i}.text`, term.text, { min: 20, max: 4000 }, key, [], citable))
  })
  return out
}

export type ParsedContent = { ok: true; content: AssetTemplateContent } | { ok: false; problems: ContentProblem[] }

/** Stored or posted content text → valid content, or why not. */
export function validContent(templateKey: string, text: string): ParsedContent {
  const content = parseContent(text)
  if (!content) return { ok: false, problems: [{ field: "content", message: "The wording is not in the template format" }] }
  const problems = contentProblems(templateKey, content)
  return problems.length === 0 ? { ok: true, content } : { ok: false, problems }
}
