import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateDebitMandatePdf } from "@/lib/pdf/debitMandate"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import {
  assertDebitMandateCreditorTenant,
  DebitMandateConfigurationError,
  getDebitMandateCreditorBankDetails,
} from "@/lib/config/debit-mandate"
import {
  DebitMandateEvidenceError,
  debitMandatePaymentTerms,
  requireDebitMandateBankDetails,
} from "@/lib/loan/debit-mandate"
import {
  PASQ_VERSION,
  verifyStoredPasqBinding,
} from "@/lib/compliance/pasq"
import { readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const staff = await prisma.user.findUnique({
      where: { id: guard.user.id },
      select: { active: true, tenantId: true },
    })
    if (!staff?.active) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // A staff row with no tenant is refused, never bound to the default tenant.
    if (!staff.tenantId || staff.tenantId !== tenant.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const loan = await prisma.loan.findUnique({
      where: { id, tenantId: tenant.id },
      include: {
        client: {
          select: {
            firstName: true,
            lastName: true,
            idNumber: true,
            phone: true,
            email: true,
            bankName: true,
            bankBranchCode: true,
            bankAccountNumber: true,
            accountType: true,
          },
        },
        application: {
          select: {
            id: true,
            clientId: true,
            productId: true,
            initiationFeePayment: true,
            affordabilityResult: true,
            creditLifeDisclosureSha256: true,
            pasqVersion: true,
            pasqGeneratedAt: true,
            pasqDocumentId: true,
            pasqDocumentSha256: true,
            pasqEvidence: true,
            pasqEvidenceSha256: true,
            pasqAcknowledgedAt: true,
            pasqAcknowledgedBy: true,
            pasqAcknowledgedSha256: true,
            approvedPasqDocumentSha256: true,
          },
        },
        repaymentSchedule: {
          orderBy: { installmentNo: "asc" },
          select: {
            installmentNo: true,
            dueDate: true,
            principalDue: true,
            interestDue: true,
            feesDue: true,
            totalDue: true,
          },
        },
      },
    })

    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    // A debit mandate is a consumer document; an entity borrower is refused.
    if (!hasClientBorrower(loan) || loan.application.clientId === null) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }

    let bankDetails
    let paymentTerms
    let creditorBankDetails
    try {
      bankDetails = requireDebitMandateBankDetails(loan.client)
      let pasqEvidence
      if (loan.application.pasqVersion === PASQ_VERSION) {
        const approval = readAffordabilitySnapshotStore(
          loan.application.affordabilityResult,
        ).approval
        const creditLifeDisclosureSha256 =
          loan.application.creditLifeDisclosureSha256
        if (!approval || !creditLifeDisclosureSha256) {
          throw new DebitMandateEvidenceError(
            "The acknowledged PASQ billing evidence is missing or invalid.",
          )
        }
        const binding = verifyStoredPasqBinding(loan.application, {
          tenantId: loan.tenantId,
          applicationId: loan.application.id,
          clientId: loan.application.clientId,
          productId: loan.application.productId,
          calculatorPricingFingerprint:
            approval.calculator.pricingFingerprint,
          creditLifeDisclosureSha256,
          requireApprovalBinding: true,
        })
        if (!binding.ok) {
          throw new DebitMandateEvidenceError(
            "The acknowledged PASQ billing evidence is missing or invalid.",
          )
        }
        pasqEvidence = binding.evidence
      }
      paymentTerms = debitMandatePaymentTerms({
        schedule: loan.repaymentSchedule,
        principal: loan.principal,
        totalInterest: loan.totalInterest,
        totalRepayable: loan.totalRepayable,
        initiationFee: loan.initiationFee,
        initiationFeePayment: loan.application.initiationFeePayment,
        startDate: loan.startDate,
        maturityDate: loan.maturityDate,
        affordabilityResult: loan.application.affordabilityResult,
        pasqEvidence,
      })
      assertDebitMandateCreditorTenant(tenant.id)
      creditorBankDetails = getDebitMandateCreditorBankDetails()
    } catch (error) {
      if (error instanceof DebitMandateEvidenceError) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      if (error instanceof DebitMandateConfigurationError) {
        return NextResponse.json({ error: error.message }, { status: 503 })
      }
      throw error
    }

    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal

    const pdf = await generateDebitMandatePdf({
      lender: lender.identity,
      logo: await getLenderLogo(tenant.id),
      creditorBank: creditorBankDetails,
      client: {
        firstName: loan.client.firstName,
        lastName: loan.client.lastName,
        idNumber: loan.client.idNumber,
        phone: loan.client.phone ?? undefined,
        email: loan.client.email ?? undefined,
        ...bankDetails,
      },
      loan: {
        reference: loan.reference,
        ...paymentTerms,
      },
    })

    // This draft contains the consumer's full ID and bank-account number.
    // Fail closed if the POPIA access register cannot be written.
    await prisma.documentAccessLog.create({
      data: {
        documentId: loan.id,
        accessorType: "staff",
        accessorId: guard.user.id,
        action: "view_draft",
        ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          ?? req.headers.get("x-real-ip")
          ?? null,
        userAgent: req.headers.get("user-agent") ?? null,
      },
    })

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="DebitMandate-DRAFT-${loan.reference}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Document-State": "DRAFT",
      },
    })
  })
}
