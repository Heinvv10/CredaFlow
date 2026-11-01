import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { disburseKeyFactsLoan } from "./disburse"
import { KEY_FACTS_PAYOUT_NOTE } from "./payout-terms"

/**
 * The disburse route's answer for a key-facts application: it books the loan (lib/non-nca-documents/disburse.ts)
 * and answers with the same JSON shape the staff form reads (`success`, `loanId`, `loanRef`, or `error` and
 * `disbursementPrecondition`). Null for an NCA_PASQ application, which carries on down the NCA route untouched.
 */
export async function keyFactsDisbursement(args: {
  tenantId: string
  applicationId: string
  user: { id: string; email: string }
  bankRef: unknown
}): Promise<NextResponse | null> {
  const row = await prisma.loanApplication.findFirst({ where: { id: args.applicationId, tenantId: args.tenantId }, select: { disclosureRegime: true } })
  if (row?.disclosureRegime !== "KEY_FACTS") return null
  const result = await disburseKeyFactsLoan(args)
  if (!result.ok) return NextResponse.json({ error: result.error, disbursementPrecondition: result.precondition, affordabilitySnapshot: result.affordabilitySnapshot }, { status: result.status })
  return NextResponse.json({ success: true, loanId: result.loanId, loanRef: result.loanRef, payout: { channel: result.payoutChannel, note: KEY_FACTS_PAYOUT_NOTE } })
}
