/**
 * The account statement for an entity-borrower (asset-finance) loan (goal
 * §4.11). The same renderer as a consumer statement, lib/pdf/statement.ts,
 * with the ENTITY printed as the borrower: legal name, registration number,
 * address. That renderer's consumer branch is untouched, so consumer
 * statements stay byte-identical (scripts/nca-pdf-fingerprint.ts).
 *
 * Served by the staff route app/api/loans/[id]/statement (staff only for an
 * entity loan) and the portal route app/api/portal/asset-finance/loans/
 * [loanId]/statement (the entity's authorised people). Each caller does its
 * own access check and writes its own DocumentAccessLog row; this only loads
 * and renders.
 *
 * The loan-to-statement mapping mirrors the consumer branch of the staff
 * route field for field; a change to one belongs in the other.
 */
import type { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateStatementPdf, type StatementEntity } from "@/lib/pdf/statement"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { renderLeaseStatementPdf } from "./lease/statement-pdf"

export type EntityStatementResult =
  | { kind: "pdf"; bytes: Buffer; filename: string }
  | { kind: "not_found" }
  /** the lender identity is not configured: the 409 to return */
  | { kind: "refused"; response: NextResponse }

interface EntityParticulars {
  legalName: string
  registrationNumber: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  province: string | null
  postalCode: string | null
}

/** The entity block: one address line, parts joined, absent when none is on file. */
export function statementEntity(entity: EntityParticulars): StatementEntity {
  const address = [entity.addressLine1, entity.addressLine2, entity.city, entity.province, entity.postalCode]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(", ")
  return { legalName: entity.legalName, registrationNumber: entity.registrationNumber, address: address || undefined }
}

export async function renderEntityStatementPdf(
  tenantId: string,
  loanId: string,
  statementDate: Date = new Date(),
): Promise<EntityStatementResult> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId, entityId: { not: null } },
    include: {
      entity: {
        select: {
          legalName: true, registrationNumber: true,
          addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true,
        },
      },
      product: { select: { name: true } },
      repaymentSchedule: { orderBy: { installmentNo: "asc" } },
      payments: { orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }] },
    },
  })
  if (!loan?.entity) return { kind: "not_found" }
  // A lease's statement lists rentals, not capital and interest (./lease/statement-pdf.ts).
  if (loan.contractType === "OPERATING_LEASE" || loan.contractType === "FULL_MAINTENANCE_LEASE") {
    return renderLeaseStatementPdf(tenantId, loanId, statementDate)
  }

  const lender = await lenderIdentityOrRefusal(tenantId)
  if (lender.refusal) return { kind: "refused", response: lender.refusal }

  const figures = await loanSettlementFigures(prisma, loan, statementDate)
  const bytes = await generateStatementPdf({
    lender: lender.identity,
    logo: await getLenderLogo(tenantId),
    entity: statementEntity(loan.entity),
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
      arrearsAmount: figures.arrearsIncludingCharges,
    },
    product: { name: loan.product.name },
    schedule: loan.repaymentSchedule.map((s) => ({
      installmentNo: s.installmentNo,
      dueDate: s.dueDate,
      totalDue: s.totalDue,
      totalPaid: s.totalPaid,
      status: s.status,
    })),
    payments: loan.payments.map((p) => ({
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
  return { kind: "pdf", bytes, filename: `statement-${loan.reference}-${statementDate.toISOString().slice(0, 10)}.pdf` }
}
