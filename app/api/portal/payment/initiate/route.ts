import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { createStitchPayment } from "@/lib/stitch"
import { withTenantContext } from "@/lib/tenant"
import { SettlementOverpaymentError } from "@/lib/loan/settlement"
import { CHARGES_FLAG_INCLUDE } from "@/lib/loan/charges-replay"
import { loadReceiptReplay, projectReceiptWithReplay } from "@/lib/loan/charge-aware-receipt"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id

    const client = await prisma.client.findFirst({
      where: { email: session.user.email, tenantId },
      select: { id: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 })
    }

    const body = (await req.json()) as { loanId?: string; amount?: number }
    const { loanId, amount } = body

    if (
      !loanId
      || typeof amount !== "number"
      || !Number.isFinite(amount)
      || amount <= 0
    ) {
      return NextResponse.json({ error: "loanId and a positive amount (rands) are required" }, { status: 400 })
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, clientId: client.id, tenantId },
      include: {
        repaymentSchedule: { orderBy: { dueDate: "asc" } },
        tenant: CHARGES_FLAG_INCLUDE,
      },
    })

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    }
    // The statuses the webhook books a receipt against: a client in default
    // must be able to pay.
    if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
      return NextResponse.json({ error: "Loan is not active" }, { status: 400 })
    }
    const amountCents = Math.round(amount * 100)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return NextResponse.json({ error: "Amount is outside the supported range" }, { status: 400 })
    }
    const asOf = new Date()
    // Bounded the same way the webhook will book it: default charges are owed
    // on top of the schedule, so a payment covering them is not an over-payment.
    const replay = await loadReceiptReplay(prisma, loan, asOf)
    try {
      projectReceiptWithReplay(replay, {
        loan,
        schedule: loan.repaymentSchedule,
        amount: amountCents,
        receivedAt: asOf,
        asOf,
      })
    } catch (error) {
      if (!(error instanceof SettlementOverpaymentError)) throw error
      const maxAmountCents = error.maxAmountCents
      return NextResponse.json(
        {
          error: "Payment exceeds the current settlement amount.",
          maxAmountCents,
        },
        { status: 422 },
      )
    }

    const externalReference = `PAY-${loanId.slice(-8)}-${Date.now()}`
    // Stitch redirects the payer's browser here after payment. This MUST target
    // the callback ROUTE HANDLER at /api/portal/payment/callback (which only
    // bounces to the success/failure page; the webhook settles) — NOT the /api-less
    // /portal/payment/callback, which has no page/route and 404s (PORT-01).
    try {
      const redirectUrl = `${requireAppBaseUrl()}/api/portal/payment/callback`
      const stitch = await createStitchPayment({
        amountRands: amountCents / 100,
        payerReference: loan.reference.slice(0, 12),
        beneficiaryReference: loan.reference,
        externalReference,
        redirectUrl,
      })

      await prisma.stitchPaymentRequest.create({
        data: {
          stitchId: stitch.id,
          loanId,
          clientId: client.id,
          amount: amountCents,
          redirectUrl,
          stitchUrl: stitch.url,
          externalReference,
        },
      })

      return NextResponse.json({ url: stitch.url })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Payment initiation failed"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}
