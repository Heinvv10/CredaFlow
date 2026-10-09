/**
 * The PASQ and the credit agreement are two halves of ONE thing the consumer
 * signs. `GET /api/applications/[id]/signing-packet` issues them concatenated,
 * PASQ first, and the upload gate counts the returned pages against the sum of
 * both — so a half can never be signed and returned on its own.
 *
 * The client documents folder listed them as two ordinary downloadable cards
 * badged "Locked statutory evidence", which reads as *authoritative* rather than
 * *component part*. Staff attached a 4-page half to an email, the consumer
 * signed it, and the upload was correctly refused — costing a full round trip.
 *
 * They stay in the record: both are hashed onto the application
 * (`pasqDocumentSha256`, `agreementDocumentSha256`) and the disbursement gates
 * read and re-verify those exact bytes. This only changes where they appear.
 */
const SIGNING_PACKET_COMPONENT_TYPES = new Set([
  "FORM_20_PRE_AGREEMENT",
  "CREDIT_AGREEMENT",
  // The returned signed copy. It is what the lifecycle card serves once it
  // exists, so listing it separately puts a second, similar-looking PDF beside
  // the card — the exact ambiguity the card was added to remove.
  "SIGNED_AGREEMENT_PACKET",
])

export const SIGNING_PACKET_COMPONENT_NOTE =
  "Parts of the signing packet, kept for the record. Each cannot be signed on its "
  + "own — the consumer must receive the whole packet, quotation first. Use the "
  + "signing packet card above, or the application, to issue or download it."

export function isSigningPacketComponent(docType: string): boolean {
  return SIGNING_PACKET_COMPONENT_TYPES.has(docType)
}

/**
 * Split a client's folder into the documents staff act on and the packet halves.
 *
 * EXECUTED_CREDIT_AGREEMENT is deliberately NOT a component: it carries the
 * whole packet plus the execution page, so once it exists it is the single
 * document worth downloading and belongs in the main list. The lifecycle card
 * serves it too, and that redundancy is intentional — if the card's fetch
 * fails, the executed agreement must still be one click away.
 */
export function partitionSigningPacketDocuments<T extends { docType: string }>(
  docs: readonly T[],
): { primary: T[]; packetComponents: T[] } {
  const primary: T[] = []
  const packetComponents: T[] = []
  for (const doc of docs) {
    if (isSigningPacketComponent(doc.docType)) packetComponents.push(doc)
    else primary.push(doc)
  }
  return { primary, packetComponents }
}
