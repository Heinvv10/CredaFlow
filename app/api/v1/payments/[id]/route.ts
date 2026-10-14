import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { apiError, withApiKey } from "@/lib/lender-api/handler"
import { paymentSelect, toApiPayment } from "@/lib/lender-api/serializers"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params) {
  return withApiKey(req, "payments:read", async (caller) => {
    const { id } = await params
    const payment = await prisma.payment.findFirst({ where: { id, tenantId: caller.tenantId }, select: paymentSelect })
    if (!payment) return apiError(404, "not_found", "No such payment.")
    return NextResponse.json(toApiPayment(payment))
  })
}
