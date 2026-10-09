import { PDFDocument } from "pdf-lib"

/**
 * Assemble the statutory signing packet without changing either source
 * document. The PASQ is deliberately first: the consumer receives/reviews it
 * before reaching the credit agreement in the same PDF.
 */
export async function createSigningPacketPdf(
  pasqBytes: Uint8Array,
  agreementBytes: Uint8Array,
): Promise<Uint8Array> {
  const [pasq, agreement] = await Promise.all([
    PDFDocument.load(pasqBytes),
    PDFDocument.load(agreementBytes),
  ])
  if (pasq.getPageCount() < 1 || agreement.getPageCount() < 1) {
    throw new Error("Both signing-packet documents must contain at least one page")
  }

  const packet = await PDFDocument.create()
  const pasqPages = await packet.copyPages(pasq, pasq.getPageIndices())
  for (const page of pasqPages) packet.addPage(page)
  const agreementPages = await packet.copyPages(agreement, agreement.getPageIndices())
  for (const page of agreementPages) packet.addPage(page)
  return packet.save()
}
