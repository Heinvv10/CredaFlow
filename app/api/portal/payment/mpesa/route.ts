import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { SettlementOverpaymentError } from "@/lib/loan/settlement"
import { CHARGES_FLAG_INCLUDE } from "@/lib/loan/charges-replay"
import { loadReceiptReplay, projectReceiptWithReplay } from "@/lib/loan/charge-aware-receipt"
import { mpesaPaybill } from "@/lib/mobile-money/config"
import { STK_PUSH_PROVIDER_ID } from "@/lib/mobile-money/registry"
import { startStkPush } from "@/lib/mobile-money/stk-push"
import { MobileMoneyProviderError } from "@/lib/mobile-money/types"

// "Pay with M-Pesa" (STK push) from the portal payment page. The borrower's
// phone is sent to the provider only; the push is recorded with its last four
// digits (lib/mobile-money/stk-push.ts) and booked when its result arrives.

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const email = session.user.email

  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id
    if (!mpesaPaybill()) return NextResponse.json({ error: "M-Pesa payments are not offered" }, { status: 404 })

    const client = await prisma.client.findFirst({ where: { email, tenantId }, select: { id: true } })
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

    const { loanId, amount, phone } = (await req.json()) as { loanId?: unknown; amount?: unknown; phone?: unknown }
    // M-Pesa takes whole shillings only.
    if (typeof loanId !== "string" || !loanId || typeof phone !== "string"
      || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return NextResponse.json({ error: "loanId, phone and a positive whole amount are required" }, { status: 400 })
    }
    const amountCents = amount * 100
    if (!Number.isSafeInteger(amountCents)) {
      return NextResponse.json({ error: "Amount is outside the supported range" }, { status: 400 })
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, clientId: client.id, tenantId },
      include: { repaymentSchedule: { orderBy: { dueDate: "asc" } }, tenant: CHARGES_FLAG_INCLUDE },
    })
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    // The statuses a receipt can be booked against: a client in default must be able to pay.
    if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
      return NextResponse.json({ error: "Loan is not active" }, { status: 400 })
    }
    // Bounded as the Stitch initiate route bounds it: default charges are owed
    // on top of the schedule, so a payment covering them is not an over-payment.
    const asOf = new Date()
    try {
      const replay = await loadReceiptReplay(prisma, loan, asOf)
      projectReceiptWithReplay(replay, { loan, schedule: loan.repaymentSchedule, amount: amountCents, receivedAt: asOf, asOf })
    } catch (error) {
      if (!(error instanceof SettlementOverpaymentError)) throw error
      return NextResponse.json(
        { error: "Payment exceeds the current settlement amount.", maxAmountCents: error.maxAmountCents },
        { status: 422 },
      )
    }

    try {
      const out = await startStkPush(prisma, {
        tenantId, providerId: STK_PUSH_PROVIDER_ID, loan: { id: loan.id, reference: loan.reference },
        amountCents, phone, actorEmail: email,
      })
      if (!out.ok) {
        return NextResponse.json({ error: out.message }, { status: out.reason === "INVALID_PHONE" ? 400 : 502 })
      }
      return NextResponse.json({ transactionId: out.transactionId, status: out.status })
    } catch (error) {
      if (!(error instanceof MobileMoneyProviderError)) throw error
      return NextResponse.json({ error: "M-Pesa payments are temporarily unavailable" }, { status: 503 })
    }
  })
}
