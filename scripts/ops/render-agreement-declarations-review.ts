/** Separate UNMERGED legal review pack. No existing fingerprints are repinned. */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { calculateLoan } from "../../lib/loan-calculator"
import { generateCreditAgreementPdfWithAnchors } from "../../lib/pdf/creditAgreement"
import { stampExecutedAgreement } from "../../lib/pdf/executed-agreement"
import { declarationEvidenceData, signatureDigest } from "../../lib/compliance/agreement-declarations.server"
import { sha256DocumentBytes } from "../../lib/documents/content-integrity"
import { boundaryLoanInput, boundaryAgreementInput, boundaryStartDate } from "../nca-pdf-fingerprint"

async function main() {
  const output = process.argv[2]
  if (!output) throw new Error("Provide output directory")
  await mkdir(output, { recursive: true })
  const manifest: Record<string, string> = {}
  for (const term of [3, 60]) {
    const calc = calculateLoan(boundaryLoanInput(term), boundaryStartDate)
    const original = await generateCreditAgreementPdfWithAnchors(boundaryAgreementInput("agreement", calc))
    const signature = "Synthetic Signer"
    const execution = { consumerSignature: signature, consumerSignedAt: new Date("2026-07-23T08:00:00Z"), providerSignature: "Synthetic Provider", providerName: "Synthetic Provider", countersignedAt: new Date("2026-07-23T09:00:00Z") }
    const declarations = { id: `synthetic-declarations-${term}`, ...declarationEvidenceData({ tenantId: "synthetic-tenant", applicationId: `synthetic-application-${term}`, clientId: "synthetic-client", signerId: "synthetic-client", method: "portal", signedAt: execution.consumerSignedAt, agreementDocumentSha256: sha256DocumentBytes(original.bytes), pasqDocumentSha256: "b".repeat(64), signatureSha256: signatureDigest(signature) }) }
    const before = await stampExecutedAgreement({ agreementBytes: original.bytes, anchors: original.signatureAnchors, execution })
    const after = await stampExecutedAgreement({ agreementBytes: original.bytes, anchors: original.signatureAnchors, execution, declarations })
    for (const [kind, bytes] of [["UNSIGNED", original.bytes], ["BEFORE", before.bytes], ["CANDIDATE", after.bytes]] as const) {
      const filename = `agreement-${term}-${kind}.pdf`
      await writeFile(path.join(output, filename), bytes)
      manifest[filename] = sha256DocumentBytes(bytes)
    }
  }
  await writeFile(path.join(output, "SHA256.json"), JSON.stringify(manifest, null, 2) + "\n")
}
void main()
