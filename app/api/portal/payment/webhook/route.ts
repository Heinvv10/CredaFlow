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

function parsePayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-stitch-signature")

  // Each lender signs with its own Stitch account's secret, so the payment
  // the event names has to be found before the signature can be checked. The
  // lookup is a read by the provider's id; nothing is written, and nothing is
  // answered differently, until the signature verifies.
  //
  // StitchPaymentRequest is not tenant-scoped, so this read is allowed with no
  // tenant context; the loan it points at names the tenant that owns the money.
  const payload = parsePayload(rawBody)
  const data = payload?.data as Record<string, unknown> | undefined
  const stitchId = payload?.type === "payment.completed" ? String(data?.id ?? "") : ""
  const stitchPayment = stitchId ? await findStitchPayment(stitchId) : null
  const owner = stitchPayment?.loan.tenantId ?? null

  const secret = await loadStitchWebhookSecret(owner)
  if (!secret) {
    if (owner) {
      console.error("[webhook] no Stitch webhook secret is configured for the paying lender — rejecting webhook")
      return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
    }
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  if (!verifyStitchSignature({ body: rawBody, signature: signature ?? "", secret })) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (payload.type !== "payment.completed") {
    return NextResponse.json({ ok: true })
  }

  if (!stitchId || !stitchPayment) return NextResponse.json({ ok: true })

  // Every Loan/Payment/AuditLog access below is tenant-scoped, and a webhook
  // has no session or host to resolve a tenant from.
  const tenantId = stitchPayment.loan.tenantId
  return runWithTenant(tenantId, () => settleReceipt(stitchPayment, stitchId, tenantId))
}
