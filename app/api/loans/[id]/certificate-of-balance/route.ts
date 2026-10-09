import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateCertificateOfBalancePdf } from "@/lib/pdf/certificateOfBalance"
import { certificatePaidToDate, certificateSettlement, loanSettlementFigures } from "@/lib/loan/charges-summary"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { getLenderLogo } from "@/lib/config/lender-logo"

type RouteCtx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const loan = await prisma.loan.findUnique({
      where: { id, tenantId: tenant.id },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true, addressLine1: true, city: true } },
        repaymentSchedule: { orderBy: { dueDate: "asc" } },
      },
    })

    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })

    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal

    // What it takes to settle today, itemised, default charges included.
    const figures = await loanSettlementFigures(prisma, loan, new Date())
    const pdf = await generateCertificateOfBalancePdf({
      lender: lender.identity,
      logo: await getLenderLogo(tenant.id),
      client: {
        firstName: loan.client.firstName,
        lastName: loan.client.lastName,
        idNumber: loan.client.idNumber,
        addressLine1: loan.client.addressLine1 ?? undefined,
        city: loan.client.city ?? undefined,
      },
      loan: {
        reference: loan.reference,
        startDate: loan.startDate,
        maturityDate: loan.maturityDate,
        principal: loan.principal,
        totalRepayable: loan.totalRepayable,
        totalPaid: loan.totalPaid,
        outstandingPrincipal: loan.outstandingPrincipal,
        // Charge-inclusive, as on the Section 129 notice.
        arrearsAmount: figures.arrearsIncludingCharges,
        daysInArrears: loan.daysInArrears ?? 0,
        // NCA s.108: this certificate is a legal statement of the consumer's
        // account. The rate it states must be the rate they contracted at,
        // which disburse/route.ts freezes onto the Loan row from the approval
        // snapshot. Reading the live LoanProduct row here meant ordinary
        // repricing retroactively misstated this document for every existing
        // loan on that product.
        interestRatePm: loan.interestRatePm,
        lastPaymentDate: loan.lastPaymentDate,
        lastPaymentAmount: loan.lastPaymentAmount,
      },
      settlement: certificateSettlement(figures),
      paymentsReceived: certificatePaidToDate(figures),
    })

    // POPIA: every access to a consumer's document is logged. The sibling
    // statement route does the same against loan.id (DocumentAccessLog.documentId
    // is an unconstrained string, not an FK to ClientDocument, because these
    // certificates are rendered on demand rather than stored). requireApiRole
    // admits staff only -- CLIENT never passes a staff gate -- so the accessor
    // type is a fact here, not an assumption. Non-fatal: a logging outage must
    // not deny a consumer their statutory certificate.
    try {
      await prisma.documentAccessLog.create({
        data: {
          documentId: loan.id,
          accessorType: "staff",
          accessorId: guard.user.id,
          action: "download",
          ipAddress: req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
    } catch {
      // Non-critical — do not fail the download.
    }

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="COB-${loan.reference}.pdf"`,
      },
    })
  })
}
