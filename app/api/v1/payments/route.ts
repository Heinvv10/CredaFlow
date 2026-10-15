import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withApiKey } from "@/lib/lender-api/handler"
import { hasScope } from "@/lib/lender-api/scopes"
import { optionalIdParam, pageOf, pageQuery, pageWhere, parsePageParams } from "@/lib/lender-api/pagination"
import { paymentSelect, toApiPayment } from "@/lib/lender-api/serializers"

export async function GET(req: Request) {
  return withApiKey(req, "payments:read", async (caller) => {
    const url = new URL(req.url)
    const page = parsePageParams(url)
    if (page instanceof Response) return page
    const loanId = optionalIdParam(url, "loanId")
    if (loanId instanceof Response) return loanId
    const rows = await prisma.payment.findMany({
      where: { tenantId: caller.tenantId, ...(loanId ? { loanId } : {}), ...pageWhere(page) },
      select: paymentSelect,
      ...pageQuery(page),
    })
    const pii = hasScope(caller.scopes, "pii:read")
    return NextResponse.json(pageOf(rows, page, (p) => toApiPayment(p, { pii })))
  })
}
