// What lender wording may contain (SPEC.md §2). Run on every draft, preview,
// approval and issuance, so stored content that fails today's rules is never
// approved or printed. Semantic limits a machine cannot check are the
// approver's attestation, not this file's.
import { winAnsiSafe } from "@/lib/pdf/executed-agreement"
import { MAX_ADDITIONAL_TERMS, parseTemplateKey, type AssetTemplateKey } from "./families"
import { parseContent, type AssetTemplateContent } from "./content"
import { ASSET_TEMPLATE_TOKENS, hasStrayBraces, tokensIn } from "./tokens"

export interface ContentProblem {
  /** "clauses.insurance", "additionalTerms.0.text", "content" */
  field: string
  message: string
}

const MONEY = /\bR\s?\d|\bZAR\b|\brands?\b|\d\s*(?:rand|ZAR)\b/i
const RATE = /%|\bper\s*cent\b|\bpercent(?:age)?\b|\bbasis\s+points?\b/i
const CLAUSE_REFERENCE = /\bclauses?\s+(\d+(?:\.\d+)?)((?:\s*(?:,|and|or|to)\s*\d+(?:\.\d+)?)*)/gi

function textProblems(field: string, text: string, limits: { min: number; max: number }, key: AssetTemplateKey, required: readonly string[]): ContentProblem[] {
  const out: ContentProblem[] = []
  const add = (message: string) => out.push({ field, message })
  const trimmed = text.trim()
  if (trimmed.length < limits.min) add(trimmed.length === 0 ? "This text is required and cannot be left out" : `Write at least ${limits.min} characters`)
  if (text.length > limits.max) add(`At most ${limits.max} characters`)
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) add("Use plain text: tabs and control characters are not allowed")
  if (text.split("\n").some((line) => winAnsiSafe(line) !== line)) add("Contains characters the document fonts cannot print")
  if (MONEY.test(text)) add("Amounts of money come only from the deal's figures; remove the amount")
  if (RATE.test(text)) add("Rates and percentages come only from the deal's figures; remove the rate")
  if (hasStrayBraces(text)) add("A token is written {{name}}; remove the stray brace")
  const allowed = new Set<string>(key.family.tokens)
  for (const token of tokensIn(text)) {
    if (!(token in ASSET_TEMPLATE_TOKENS) || !allowed.has(token)) add(`{{${token}}} is not a token this document supports`)
  }
  for (const token of required) {
    if (!tokensIn(text).includes(token)) add(`Must contain {{${token}}}`)
  }
  const valid = new Set(key.family.protectedClauses(key.variant))
  for (const match of text.matchAll(CLAUSE_REFERENCE)) {
    const cited = [match[1], ...(match[2].match(/\d+(?:\.\d+)?/g) ?? [])]
    for (const n of cited) if (!valid.has(n)) add(`Clause ${n} does not exist in this document`)
  }
  return out
}

/** Every problem with `content` for template `templateKey`; empty when it may be saved, previewed, approved and printed. */
export function contentProblems(templateKey: string, content: AssetTemplateContent): ContentProblem[] {
  const key = parseTemplateKey(templateKey)
  if (!key) return [{ field: "content", message: "Not an asset-finance template" }]
  const out: ContentProblem[] = []
  if (content.templateKey !== templateKey) out.push({ field: "content", message: "This wording belongs to a different document" })
  const expected = key.family.editable.map((c) => c.id).sort()
  const given = Object.keys(content.clauses).sort()
  if (expected.join("|") !== given.join("|")) out.push({ field: "clauses", message: `This document's editable clauses are exactly: ${expected.join(", ") || "none"}` })
  for (const clause of key.family.editable) {
    const text = content.clauses[clause.id]
    if (typeof text === "string") out.push(...textProblems(`clauses.${clause.id}`, text, { min: 20, max: 6000 }, key, clause.requiredTokens))
  }
  if (content.additionalTerms.length > MAX_ADDITIONAL_TERMS) out.push({ field: "additionalTerms", message: `At most ${MAX_ADDITIONAL_TERMS} additional terms` })
  content.additionalTerms.forEach((term, i) => {
    out.push(...textProblems(`additionalTerms.${i}.heading`, term.heading, { min: 3, max: 80 }, key, []))
    if (term.heading.includes("\n")) out.push({ field: `additionalTerms.${i}.heading`, message: "A heading is one line" })
    out.push(...textProblems(`additionalTerms.${i}.text`, term.text, { min: 20, max: 4000 }, key, []))
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
