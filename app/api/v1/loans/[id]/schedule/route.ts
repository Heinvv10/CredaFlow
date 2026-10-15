import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { apiError, withApiKey } from "@/lib/lender-api/handler"
import { scheduleSelect, toApiScheduleItem } from "@/lib/lender-api/serializers"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params) {
  return withApiKey(req, "loans:read", async (caller) => {
    const { id } = await params
    const loan = await prisma.loan.findFirst({ where: { id, tenantId: caller.tenantId }, select: { id: true } })
    if (!loan) return apiError(404, "not_found", "No such loan.")
    const rows = await prisma.repaymentSchedule.findMany({
      where: { loanId: loan.id, tenantId: caller.tenantId },
      select: scheduleSelect,
      orderBy: { installmentNo: "asc" },
    })
    return NextResponse.json({ loanId: loan.id, data: rows.map(toApiScheduleItem) })
  })
}
