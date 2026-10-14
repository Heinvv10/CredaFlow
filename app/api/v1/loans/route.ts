import { NextResponse } from "next/server"
import type { LoanStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withApiKey } from "@/lib/lender-api/handler"
import { optionalEnumParam, optionalIdParam, pageOf, pageQuery, parsePageParams } from "@/lib/lender-api/pagination"
import { loanSelect, toApiLoan } from "@/lib/lender-api/serializers"

const LOAN_STATUSES: readonly LoanStatus[] = [
  "ACTIVE", "COMPLETED", "DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF", "RESTRUCTURED", "CANCELLED",
]

export async function GET(req: Request) {
  return withApiKey(req, "loans:read", async (caller) => {
    const url = new URL(req.url)
    const page = parsePageParams(url)
    if (page instanceof Response) return page
    const status = optionalEnumParam(url, "status", LOAN_STATUSES)
    if (status instanceof Response) return status
    const clientId = optionalIdParam(url, "clientId")
    if (clientId instanceof Response) return clientId
    const rows = await prisma.loan.findMany({
      where: { tenantId: caller.tenantId, ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) },
      select: loanSelect,
      ...pageQuery(page),
    })
    return NextResponse.json(pageOf(rows, page, toApiLoan))
  })
}
