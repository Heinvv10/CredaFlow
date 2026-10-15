import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole, requireOwnerOrStaff } from "@/lib/auth-guards"
import { generateStatementPdf } from "@/lib/pdf/statement"
import { documentLoanFigures, documentScheduleRow, loanSettlementFigures } from "@/lib/loan/charges-summary"
import { withTenantContext } from "@/lib/tenant"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { hasClientBorrower } from "@/lib/borrower"
import { renderEntityStatementPdf } from "@/lib/asset-finance/documents/statement-pdf"
import { recordedCallerIp } from "@/lib/rate-limit"

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
    // An entity borrower (asset finance): staff only on this route (the
    // entity's own people use the portal's asset-finance statement route),
    // rendered with the entity as the borrower; its access is logged first.
    if (!hasClientBorrower(loan)) {
      const staff = await requireApiRole("READONLY")
      if (staff.error) return staff.error
      // Logged BEFORE rendering and not swallowed, shaped like
      // lib/document-auth.ts logDocumentAccess (not imported: it pulls
      // next-auth into this route's module graph): no entity statement leaves
      // without its access row.
      await prisma.documentAccessLog.create({
        data: {
          documentId: loan.id,
          accessorType: "staff",
          accessorId: staff.user.id,
          action: "download",
          ipAddress: recordedCallerIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
      const rendered = await renderEntityStatementPdf(tenant.id, loan.id)
      if (rendered.kind === "not_found") return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      if (rendered.kind === "refused") return rendered.response
      return new Response(new Uint8Array(rendered.bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${rendered.filename}"`,
        },
      })
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
        totalPaid: loan.totalPaid,
        interestRatePm: loan.interestRatePm,
        interestModel: loan.interestModel,
        status: loan.status,
        startDate: loan.startDate,
        maturityDate: loan.maturityDate,
        // Zero for a loan CANCELLED by a disbursement reversal (nothing owed).
        ...documentLoanFigures(loan),
        // Charge-inclusive, as on the Section 129 notice.
        arrearsAmount: figures.arrearsIncludingCharges,
      },
      product: { name: loan.product.name },
      schedule: loan.repaymentSchedule.map(documentScheduleRow).map(s => ({
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
