import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireOwnerOrStaff } from "@/lib/auth-guards"
import { generateStatementPdf } from "@/lib/pdf/statement"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { withTenantContext } from "@/lib/tenant"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { getLenderLogo } from "@/lib/config/lender-logo"

type RouteCtx = { params: Promise<{ id: string }> }

// Callable by both staff (any role) and the portal CLIENT for their own loan.
export async function GET(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const loan = await prisma.loan.findUnique({
      where: { id, tenantId: tenant.id },
      include: {
        client: true,
        product: { select: { name: true } },
        repaymentSchedule: { orderBy: { installmentNo: "asc" } },
        payments: { orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }] },
        application: { select: { agreementSignedAt: true } },
      },
    })

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    }

    const access = await requireOwnerOrStaff(loan.clientId)
    if (access.error) return access.error

    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal

    const statementDate = new Date()
    const figures = await loanSettlementFigures(prisma, loan, statementDate)
    const pdf = await generateStatementPdf({
      lender: lender.identity,
      logo: await getLenderLogo(tenant.id),
      client: {
        firstName: loan.client.firstName,
        lastName: loan.client.lastName,
        idNumber: loan.client.idNumber,
        email: loan.client.email,
        addressLine1: loan.client.addressLine1 ?? undefined,
        city: loan.client.city ?? undefined,
      },
      loan: {
        id: loan.id,
        reference: loan.reference,
        principal: loan.principal,
        totalRepayable: loan.totalRepayable,
        totalPaid: loan.totalPaid,
        outstandingPrincipal: loan.outstandingPrincipal,
        interestRatePm: loan.interestRatePm,
        interestModel: loan.interestModel,
        status: loan.status,
        startDate: loan.startDate,
        maturityDate: loan.maturityDate,
        daysInArrears: loan.daysInArrears,
        // Charge-inclusive, as on the Section 129 notice.
        arrearsAmount: figures.arrearsIncludingCharges,
      },
      product: { name: loan.product.name },
      schedule: loan.repaymentSchedule.map(s => ({
        installmentNo: s.installmentNo,
        dueDate: s.dueDate,
        totalDue: s.totalDue,
        totalPaid: s.totalPaid,
        status: s.status,
      })),
      payments: loan.payments.map(p => ({
        createdAt: p.createdAt,
        receivedAt: p.receivedAt,
        amount: p.amount,
        paymentMethod: p.paymentMethod,
        reference: p.reference,
        reversed: p.reversed,
        reversedAt: p.reversedAt,
        reversalReason: p.reversalReason,
        allocationStatus: p.allocationStatus,
        reconciliationReason: p.reconciliationReason,
        defaultInterestAllocated: p.defaultInterestAllocated,
        chargeFeesAllocated: p.chargeFeesAllocated,
      })),
      statementDate,
      charges: figures.charges
        ? { postings: figures.charges.postings, outstanding: figures.chargesOutstanding, settlement: figures.totalToSettle }
        : undefined,
    })

    const dateStr = statementDate.toISOString().slice(0, 10)
    const filename = `statement-${loan.reference}-${dateStr}.pdf`

    const accessorId = access.type === "staff" ? access.user.id : access.clientId
    try {
      await prisma.documentAccessLog.create({
        data: {
          documentId: loan.id,
          accessorType: access.type,
          accessorId,
          action: "download",
        },
      })
    } catch {
      // Non-critical — don't fail the download
    }

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  })
}
