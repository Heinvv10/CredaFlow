// The fingerprint of a variant's protected system output: the SHA-256 over
// its preview PDFs in every deal shape (./preview.ts previewShapes: entity
// types, rate bases, lease timing and maintenance risk, lessee kind, NCA
// size), each rendered for a fixed synthetic lender with fixed placeholder
// text in every editable clause and no additional terms. A change to what the
// system prints on any of those branches changes it; the lender's own text
// does not. A branch no shape reaches is not covered (SPEC.md proof limits):
// add a shape when adding a branch.
//
// An approval records the fingerprint it was given against
// (DocumentTemplateVersion.approvedSystemSha256), and a version issues only
// while the fingerprint is unchanged: when CredaFlow changes the protected
// wording, every lender approves it again. fingerprint.test.ts pins each
// variant's value with SYSTEM_REVISION, so such a change cannot land unnoticed.
import { createHash } from "node:crypto"
import { editableClauses, parseTemplateKey, STARTER_REVISION } from "./families"
import { previewShapes, renderTemplatePreview } from "./preview"

const FINGERPRINT_LENDER = {
  legalName: "Fingerprint Lender (Pty) Ltd", tradingName: "Fingerprint Lender", companyRegNumber: "2000/000000/07",
  ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Fingerprint Street", "Testville", "0000"],
}

const memo = new Map<string, Promise<string>>()

/** The current fingerprint of `templateKey`'s protected output. Constant for a build, so memoised. */
export function systemFingerprint(templateKey: string): Promise<string> {
  const cached = memo.get(templateKey)
  if (cached) return cached
  const key = parseTemplateKey(templateKey)
  if (!key) return Promise.reject(new RangeError(`Not an asset-finance template: ${templateKey}`))
  const content = {
    schema: 1 as const, templateKey, starterRevision: STARTER_REVISION, additionalTerms: [],
    clauses: Object.fromEntries(editableClauses(key).map((c) => [c.id, `Fingerprint placeholder for clause ${c.number}. ${c.requiredTokens.map((t) => `{{${t}}}`).join(" ")}`.trim()])),
  }
  const fingerprint = (async () => {
    const parts: string[] = []
    for (const shape of previewShapes(templateKey)) {
      const pdf = await renderTemplatePreview(templateKey, content, FINGERPRINT_LENDER, shape.id)
      parts.push(`${shape.id}:${createHash("sha256").update(pdf).digest("hex")}`)
    }
    return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex")
  })()
  memo.set(templateKey, fingerprint)
  // A failed render is not remembered: the next call tries again.
  fingerprint.catch(() => memo.delete(templateKey))
  return fingerprint
}
