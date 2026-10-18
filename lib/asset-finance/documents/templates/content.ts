// A version's lender wording: its stored shape, the canonical JSON the
// database hashes (DocumentTemplateVersion.content / contentSha256), and the
// starter content a lender adopts.
import { createHash } from "node:crypto"
import { editableClauses, STARTER_REVISION, type AssetTemplateKey } from "./families"

export interface AdditionalTerm {
  heading: string
  text: string
}

export interface AssetTemplateContent {
  schema: 1
  templateKey: string
  /** The starter revision this wording was adopted from (or copied through). */
  starterRevision: string
  /** Editable clause id → its text ({{tokens}} unresolved). Exactly the family's editable ids. */
  clauses: Record<string, string>
  additionalTerms: AdditionalTerm[]
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}

/** Sorted keys, no whitespace: the same content is always the same text and hash. */
export function canonicalContent(content: AssetTemplateContent): string {
  return JSON.stringify(sortKeys(content))
}

/** What the database computes: SHA-256 of the UTF-8 content text, lowercase hex. */
export function contentSha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/** The starter wording of a family variant, as a lender adopts it. */
export function starterContent(key: AssetTemplateKey): AssetTemplateContent {
  return {
    schema: 1,
    templateKey: key.key,
    starterRevision: STARTER_REVISION,
    clauses: Object.fromEntries(editableClauses(key).map((c) => [c.id, c.starter])),
    additionalTerms: [],
  }
}

/** Parse stored content text; null if it is not this shape (the validator explains why). */
export function parseContent(text: string): AssetTemplateContent | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (v.schema !== 1 || typeof v.templateKey !== "string" || typeof v.starterRevision !== "string") return null
  if (v.clauses === null || typeof v.clauses !== "object" || Array.isArray(v.clauses)) return null
  if (!Object.values(v.clauses).every((t) => typeof t === "string")) return null
  if (!Array.isArray(v.additionalTerms)) return null
  if (!v.additionalTerms.every((t) => t !== null && typeof t === "object" && typeof t.heading === "string" && typeof t.text === "string" && Object.keys(t).length === 2)) return null
  if (Object.keys(v).length !== 5) return null
  return value as AssetTemplateContent
}
