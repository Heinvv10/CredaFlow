/**
 * Round-3 adversarial edge test of the protected-output fingerprint
 * (fingerprint.ts). The fingerprint is the SHA-256 of ONE synthetic preview per
 * variant (a COMPANY borrower, PRIME rate, ...). Protected wording the system
 * prints only for other deals (another entity type, a fixed rate, ...) is not
 * in that PDF, so CredaFlow can change it without any fingerprint changing and
 * without any lender re-approving: the claim "when CredaFlow changes the
 * protected wording, every lender approves it again" does not hold for it.
 *
 * DEFECT tests failed on feat/lender-owned-templates 1a68ba62; since the
 * round-3 fix the fingerprint hashes every deal shape (preview.ts
 * previewShapes) and these pass.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { texts, prose } from "../nca/nca-wording.test-helpers"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal"
import { starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { systemFingerprint } from "./fingerprint"
import { previewShapes, renderTemplatePreview } from "./preview"

const FINGERPRINT_LENDER = {
  legalName: "Fingerprint Lender (Pty) Ltd", tradingName: "Fingerprint Lender", companyRegNumber: "2000/000000/07",
  ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Fingerprint Street", "Testville", "0000"],
}

describe("FIXED: the fingerprint covers protected wording printed only for other deals", () => {
  it.each([
    ["TRUST", "Trust Property Control Act"],
    ["CC", "RESOLUTION OF THE MEMBERS"],
    ["PARTNERSHIP", "RESOLUTION OF THE PARTNERS"],
  ] as const)("af.resolution.standard for a %s prints protected text (%j) that the fingerprinted PDF never contains", async (type, sentence) => {
    const key = "af.resolution.standard"
    // The PDFs the fingerprint hashes: every deal shape (resolution: no editable clauses, so the starter is the input).
    const parts: string[] = []
    const shapeTexts: string[] = []
    for (const shape of previewShapes(key)) {
      const pdf = await renderTemplatePreview(key, starterContent(parseTemplateKey(key)!), FINGERPRINT_LENDER, shape.id)
      parts.push(`${shape.id}:${createHash("sha256").update(pdf).digest("hex")}`)
      shapeTexts.push(prose(await texts(pdf)))
    }
    expect(createHash("sha256").update(parts.join("\n"), "utf8").digest("hex")).toBe(await systemFingerprint(key))
    // A real deal of another entity type, rendered from the same approved version.
    const base = syntheticDealDocumentData()
    const data = { ...base, entity: { ...base.entity, type, mastersReference: type === "TRUST" ? "IT0001/2020" : null } }
    const issued = await renderDealDocument(data, "RESOLUTION", "", { templateKey: key, content: starterContent(parseTemplateKey(key)!), mark: "NONE" })
    expect(prose(await texts(issued.bytes))).toContain(sentence)
    // The fingerprint must cover every protected sentence a lender's approved document can print.
    expect(shapeTexts.some((text) => text.includes(sentence)), `${sentence} is outside the fingerprint`).toBe(true)
  }, 60_000)
})
