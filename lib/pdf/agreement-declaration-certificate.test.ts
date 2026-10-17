import { describe, expect, it } from "vitest"
import { PDFArray, PDFDocument, PDFRawStream } from "pdf-lib"
import { calculateLoan } from "@/lib/loan-calculator"
import { generateCreditAgreementPdfWithAnchors } from "./creditAgreement"
import { stampExecutedAgreement } from "./executed-agreement"
import { boundaryLoanInput, boundaryAgreementInput, boundaryStartDate } from "@/scripts/nca-pdf-fingerprint"
import { declarationEvidenceData, signatureDigest } from "@/lib/compliance/agreement-declarations.server"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
describe("proposed declaration certificate on stored agreement", () => {
  it.each([3, 60])("appends one certificate preserving every original page for %s instalments", async term => {
    const calc = calculateLoan(boundaryLoanInput(term), boundaryStartDate)
    const original = await generateCreditAgreementPdfWithAnchors(boundaryAgreementInput("agreement", calc))
    const execution = { consumerSignature: "Synthetic Consumer", consumerSignedAt: new Date("2026-07-23T08:00:00Z"), providerSignature: "Synthetic Provider", providerName: "Synthetic Provider", countersignedAt: new Date("2026-07-23T09:00:00Z") }
    const evidence = { id: "synthetic-record", ...declarationEvidenceData({ tenantId: "t", applicationId: "a", clientId: "c", signerId: "c", method: "portal", signedAt: execution.consumerSignedAt, agreementDocumentSha256: sha256DocumentBytes(original.bytes), pasqDocumentSha256: "b".repeat(64), signatureSha256: signatureDigest(execution.consumerSignature) }) }
    const base = { agreementBytes: original.bytes, anchors: original.signatureAnchors, execution }
    const without = await stampExecutedAgreement(base)
    const withEvidence = await stampExecutedAgreement({ ...base, declarations: evidence })
    const before = await PDFDocument.load(without.bytes)
    const after = await PDFDocument.load(withEvidence.bytes)
    expect(after.getPageCount()).toBe(before.getPageCount() + 1)
    const streams = (doc: PDFDocument, page: number) => {
      const contents = doc.getPage(page).node.Contents()
      if (!contents) return []
      return (contents instanceof PDFArray ? contents.asArray() : [contents]).map(object => {
        const stream = doc.context.lookup(object)
        return stream instanceof PDFRawStream ? Buffer.from(stream.getContents()).toString("hex") : String(stream)
      })
    }
    for (let i = 0; i < before.getPageCount(); i++) {
      expect(after.getPage(i).getSize()).toEqual(before.getPage(i).getSize())
      expect(streams(after, i)).toEqual(streams(before, i))
    }
    await expect(stampExecutedAgreement({ ...base, declarations: { ...evidence, signatureSha256: "c".repeat(64) } })).rejects.toThrow(/does not match/)
  })
})
