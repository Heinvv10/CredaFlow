import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { isBalanceWaiver } from "@/lib/payments/waiver"
import { sendEmail } from "@/lib/email/service"
import { getTenantFromRequest } from "@/lib/tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import { paymentReceivedEmail } from "@/lib/email/templates/portal"
import { EntityBorrowerError } from "@/lib/borrower"

interface RequestBody {
  paymentId: string
  event: "received"
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization")
  const secret = process.env.INTERNAL_API_SECRET
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: RequestBody
  try {
    body = await req.json() as RequestBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { paymentId, event } = body
  if (!paymentId || !event) {
    return NextResponse.json({ error: "Missing paymentId or event" }, { status: 400 })
  }

  const tenant = await getTenantFromRequest(req)
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  }

  // Fails closed: unconfigured identity throws instead of mailing a customer
  // an email that names no lender.
  const identity = await getLenderIdentity(tenant.id)

  if (event === "received") {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId, tenantId: tenant.id },
      include: {
        loan: {
          select: {
            reference: true,
            outstandingPrincipal: true,
            client: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    })

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }
    // These emails address a natural person; an entity borrower is refused.
    if (!payment.loan.client) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (isBalanceWaiver(payment.paymentMethod)) {
      return NextResponse.json({ error: "A waived balance is not a payment received" }, { status: 409 })
    }

    const clientName = `${payment.loan.client.firstName} ${payment.loan.client.lastName}`
    const html = paymentReceivedEmail(
      identity,
      clientName,
      payment.amount,
      payment.loan.reference,
      payment.loan.outstandingPrincipal
    )

    const result = await sendEmail({
      tenantId: tenant.id,
      to: payment.loan.client.email,
      toName: clientName,
      subject: `Payment received — ${identity.tradingName}`,
      html,
      category: "payment_received",
      referenceId: paymentId,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to send email" }, { status: 500 })
    }

    return NextResponse.json({ ok: true, messageId: result.messageId })
  }

  // There is no "due_reminder" event: a payment reminder is dunning, and dunning
  // goes out only from the reminders cron (lib/collections/reminders.ts), through
  // sendMessage with its opt-out, holds, dedupe and send window. A direct email
  // from here had none of them.
  return NextResponse.json({ error: "Unknown event" }, { status: 400 })
}
