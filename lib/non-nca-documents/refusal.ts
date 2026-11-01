import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

/**
 * The PASQ and credit-agreement ceremony routes (app/api/applications/[id]/pasq,
 * agreement, signing-packet, ...) belong to South African (NCA_PASQ) applications.
 * A key-facts application is governed by app/api/applications/[id]/loan-documents
 * and never gets a PASQ: those routes answer 409 here, before they do any work. One
 * indexed read; a PASQ application passes through untouched.
 * (Disbursement is not refused: disburse-response.ts books a key-facts loan.)
 */
export async function keyFactsRefusal(tenantId: string, applicationId: string): Promise<NextResponse | null> {
  const row = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { disclosureRegime: true } })
  if (row?.disclosureRegime !== "KEY_FACTS") return null
  return NextResponse.json(
    {
      error: "This application is governed by a key facts statement and a loan agreement, not the PASQ and credit agreement. Use the loan documents of the application.",
      nonNcaDocuments: true,
    },
    { status: 409 },
  )
}
