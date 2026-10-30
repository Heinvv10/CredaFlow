import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { documentProblem } from "./state"

/**
 * The PASQ and credit-agreement ceremony routes (app/api/applications/[id]/pasq,
 * agreement, signing-packet, ...) belong to South African (NCA_PASQ) applications.
 * A key-facts application is governed by app/api/applications/[id]/loan-documents
 * and never gets a PASQ: those routes answer 409 here, before they do any work. One
 * indexed read; a PASQ application passes through untouched. The disburse route asks
 * for "disburse", which answers with the document gate's own reason.
 */
export async function keyFactsRefusal(tenantId: string, applicationId: string, action: "ceremony" | "disburse" = "ceremony"): Promise<NextResponse | null> {
  const row = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { disclosureRegime: true, agreementSignedAt: true } })
  if (row?.disclosureRegime !== "KEY_FACTS") return null
  if (action === "disburse") {
    // The payout and loan booking of a key-facts loan are a later item; what this route does hold is the gate:
    // no documents, no disbursement, whatever is built behind it.
    const problem = row.agreementSignedAt ? await documentProblem(applicationId, false) : "the borrower has not signed the loan agreement"
    if (problem) {
      return NextResponse.json({ error: `Cannot disburse: ${problem}.`, disbursementPrecondition: "non_nca_documents" }, { status: 422 })
    }
    return NextResponse.json(
      { error: "The documents of this loan are in order, but booking the payout of a key-facts (non-NCA) loan is not available yet.", disbursementPrecondition: "non_nca_payout_unavailable" },
      { status: 409 },
    )
  }
  return NextResponse.json(
    {
      error: "This application is governed by a key facts statement and a loan agreement, not the PASQ and credit agreement. Use the loan documents of the application.",
      nonNcaDocuments: true,
    },
    { status: 409 },
  )
}
