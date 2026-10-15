import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { loadStitchWebhookSecret } from "@/lib/stitch"
import { verifyStitchSignature } from "./signature"
import { settleReceipt } from "./settle-receipt"

const findStitchPayment = (stitchId: string) =>
  prisma.stitchPaymentRequest.findUnique({
    where: { stitchId },
    include: { loan: { select: { tenantId: true } } },
  })

/** The event, when the body is a JSON object with a string `type`; null otherwise. */
function parseEvent(rawBody: string): { type: string; data?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const event = parsed as { type?: unknown; data?: unknown }
    return typeof event.type === "string" ? { type: event.type, data: event.data } : null
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-stitch-signature")

  const event = parseEvent(rawBody)
  if (!event) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  // An event type we do not act on is acknowledged so Stitch stops retrying
  // it. Nothing is looked up or written, so its signature does not matter.
  if (event.type !== "payment.completed") return NextResponse.json({ ok: true })

  // Each lender signs with its own Stitch account's secret, so the payment
  // the event names has to be found before the signature can be checked. The
  // lookup is a read by the provider's id; nothing is written, and nothing is
  // answered differently, until the signature verifies.
  //
  // StitchPaymentRequest is not tenant-scoped, so this read is allowed with no
  // tenant context; the loan it points at names the tenant that owns the money.
  const data = event.data as Record<string, unknown> | undefined
  const stitchId = String(data?.id ?? "")
  const stitchPayment = stitchId ? await findStitchPayment(stitchId) : null

  // For a payment.completed: no payment of ours, no secret, or a bad
  // signature all answer the same 401, so a caller learns nothing about which
  // payment ids exist. Only a lender missing its secret is a fault of ours,
  // and it is logged.
  const refused = NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  if (!stitchPayment) return refused
  const owner = stitchPayment.loan.tenantId
  const secret = await loadStitchWebhookSecret(owner)
  if (!secret) {
    console.error("[webhook] no Stitch webhook secret is configured for the paying lender — rejecting webhook:", owner)
    return refused
  }

  if (!verifyStitchSignature({ body: rawBody, signature: signature ?? "", secret })) {
    return refused
  }

  // Every Loan/Payment/AuditLog access below is tenant-scoped, and a webhook
  // has no session or host to resolve a tenant from.
  return runWithTenant(owner, () => settleReceipt(stitchPayment, stitchId, owner))
}
