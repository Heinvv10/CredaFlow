import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { verifyStitchSignature } from "./signature"
import { settleReceipt } from "./settle-receipt"

const findStitchPayment = (stitchId: string) =>
  prisma.stitchPaymentRequest.findUnique({
    where: { stitchId },
    include: { loan: { select: { tenantId: true } } },
  })

export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-stitch-signature")
  const secret = process.env.STITCH_WEBHOOK_SECRET

  if (!secret) {
    console.error("[webhook] STITCH_WEBHOOK_SECRET is not configured — rejecting webhook")
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  if (!verifyStitchSignature({ body: rawBody, signature: signature ?? "", secret })) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (payload.type !== "payment.completed") {
    return NextResponse.json({ ok: true })
  }

  const data = payload.data as Record<string, unknown> | undefined
  const stitchId = String(data?.id ?? "")
  if (!stitchId) return NextResponse.json({ ok: true })

  // Fetch the request row so we have the id + parent fields for the atomic update + Payment.create.
  // StitchPaymentRequest is not tenant-scoped, so this read is allowed with no
  // tenant context; the loan it points at names the tenant that owns the money.
  const stitchPayment = await findStitchPayment(stitchId)
  if (!stitchPayment) return NextResponse.json({ ok: true })

  // Every Loan/Payment/AuditLog access below is tenant-scoped, and a webhook
  // has no session or host to resolve a tenant from.
  const tenantId = stitchPayment.loan.tenantId
  return runWithTenant(tenantId, () => settleReceipt(stitchPayment, stitchId, tenantId))
}
