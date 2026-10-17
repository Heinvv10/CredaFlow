import { PDFDocument, StandardFonts } from "pdf-lib"
import { AGREEMENT_DECLARATIONS } from "@/lib/signing/agreement-declaration-set"
import type { DeclarationEvidence } from "@/lib/compliance/agreement-declarations.server"
import { A4_WIDTH, A4_HEIGHT, MARGIN, DARK, GRAY, drawText, formatDatePdf } from "./helpers"

/** Proposed legal presentation; append only to the exact stored document, never infer historic acceptance. */
export async function appendAgreementDeclarationCertificate(doc: PDFDocument, evidence: DeclarationEvidence) {
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN
  drawText(page, "Electronic declaration acceptance record", MARGIN, y, bold, 15)
  y -= 26
  for (const line of [
    `Record: ${evidence.id}`, `Application: ${evidence.applicationId}`, `Signer client: ${evidence.clientId}`,
    `Version: ${evidence.version}`, `Declaration set SHA-256: ${evidence.setSha256}`, `Accepted: ${formatDatePdf(evidence.signedAt)} (${evidence.signedAt.toISOString()})`,
    `Agreement SHA-256: ${evidence.agreementDocumentSha256}`, `PASQ SHA-256: ${evidence.pasqDocumentSha256}`,
    `Signature SHA-256: ${evidence.signatureSha256}`,
  ]) { drawText(page, line, MARGIN, y, regular, 8); y -= 18 }
  y -= 12
  drawText(page, "The signer explicitly accepted each statement below in the portal:", MARGIN, y, bold, 10)
  y -= 24
  for (const declaration of AGREEMENT_DECLARATIONS) {
    page.drawText(`[Accepted] ${declaration.text}`, { x: MARGIN, y, font: regular, size: 10, color: DARK, maxWidth: A4_WIDTH - 2 * MARGIN, lineHeight: 14 })
    y -= 48
  }
  page.drawText("This record documents electronic acceptance of the displayed statements. The original agreement pages and their printed boxes have not been altered by this record.", { x: MARGIN, y, font: regular, size: 9, color: GRAY, maxWidth: A4_WIDTH - 2 * MARGIN, lineHeight: 13 })
}
