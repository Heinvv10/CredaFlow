import type { Prisma } from "@prisma/client"

/**
 * What /api/v1 returns. Each resource has an explicit Prisma `select` (so a
 * column added to the table never leaks out by default) and a mapper. Money
 * is integer cents (`…Cents`), dates are ISO 8601 UTC. The OpenAPI schemas in
 * lib/lender-api/openapi-schemas.ts describe exactly these shapes.
 *
 * Client personal data: without the `pii:read` scope a client carries its
 * names, reference and a masked ID number only; email, phone, date of birth
 * and the full ID number need `pii:read`.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

/** Last four characters visible, the rest masked: "*********0087". */
export function maskIdNumber(idNumber: string): string {
  const visible = idNumber.slice(-4)
  return "*".repeat(Math.max(0, idNumber.length - visible.length)) + visible
}

export const clientSelect = {
  id: true, reference: true, firstName: true, lastName: true, idNumber: true,
  email: true, phone: true, dateOfBirth: true, kycStatus: true, createdAt: true,
} satisfies Prisma.ClientSelect
type ClientRow = Prisma.ClientGetPayload<{ select: typeof clientSelect }>

export function toApiClient(c: ClientRow, opts: { pii: boolean }) {
  const base = {
    id: c.id,
    reference: c.reference,
    firstName: c.firstName,
    lastName: c.lastName,
    idNumberMasked: maskIdNumber(c.idNumber),
    kycStatus: c.kycStatus,
    createdAt: c.createdAt.toISOString(),
  }
  if (!opts.pii) return base
  return { ...base, idNumber: c.idNumber, email: c.email, phone: c.phone, dateOfBirth: iso(c.dateOfBirth) }
}

export const applicationSelect = {
  id: true, reference: true, clientId: true, entityId: true, productId: true, status: true,
  appliedAmount: true, appliedTermDays: true, purpose: true,
  submittedAt: true, approvedAt: true, disbursedAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.LoanApplicationSelect
type ApplicationRow = Prisma.LoanApplicationGetPayload<{ select: typeof applicationSelect }>

export function toApiApplication(a: ApplicationRow) {
  return {
    id: a.id,
    reference: a.reference,
    clientId: a.clientId,
    entityId: a.entityId,
    productId: a.productId,
    status: a.status,
    appliedAmountCents: a.appliedAmount,
    appliedTermDays: a.appliedTermDays,
    purpose: a.purpose,
    submittedAt: iso(a.submittedAt),
    approvedAt: iso(a.approvedAt),
    disbursedAt: iso(a.disbursedAt),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

export const loanSelect = {
  id: true, reference: true, applicationId: true, clientId: true, entityId: true, productId: true,
  contractType: true, status: true, principal: true, totalInterest: true, initiationFee: true,
  totalRepayable: true, outstandingPrincipal: true, totalPaid: true, arrearsAmount: true,
  daysInArrears: true, interestRatePm: true, interestModel: true, startDate: true,
  maturityDate: true, nextPaymentDate: true, closedAt: true, createdAt: true,
} satisfies Prisma.LoanSelect
type LoanRow = Prisma.LoanGetPayload<{ select: typeof loanSelect }>

export function toApiLoan(l: LoanRow) {
  return {
    id: l.id,
    reference: l.reference,
    applicationId: l.applicationId,
    clientId: l.clientId,
    entityId: l.entityId,
    productId: l.productId,
    contractType: l.contractType,
    status: l.status,
    principalCents: l.principal,
    totalInterestCents: l.totalInterest,
    initiationFeeCents: l.initiationFee,
    totalRepayableCents: l.totalRepayable,
    outstandingPrincipalCents: l.outstandingPrincipal,
    totalPaidCents: l.totalPaid,
    arrearsAmountCents: l.arrearsAmount,
    daysInArrears: l.daysInArrears,
    interestRatePerMonth: l.interestRatePm,
    interestModel: l.interestModel,
    startDate: l.startDate.toISOString(),
    maturityDate: l.maturityDate.toISOString(),
    nextPaymentDate: iso(l.nextPaymentDate),
    closedAt: iso(l.closedAt),
    createdAt: l.createdAt.toISOString(),
  }
}

export const scheduleSelect = {
  id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true,
  feesDue: true, creditLifePremiumDue: true, totalDue: true, totalPaid: true, status: true, paidAt: true,
} satisfies Prisma.RepaymentScheduleSelect
type ScheduleRow = Prisma.RepaymentScheduleGetPayload<{ select: typeof scheduleSelect }>

export function toApiScheduleItem(s: ScheduleRow) {
  return {
    id: s.id,
    installmentNo: s.installmentNo,
    dueDate: s.dueDate.toISOString(),
    principalDueCents: s.principalDue,
    interestDueCents: s.interestDue,
    feesDueCents: s.feesDue,
    creditLifePremiumDueCents: s.creditLifePremiumDue,
    totalDueCents: s.totalDue,
    totalPaidCents: s.totalPaid,
    status: s.status,
    paidAt: iso(s.paidAt),
  }
}

export const paymentSelect = {
  id: true, loanId: true, amount: true, paymentMethod: true, reference: true,
  allocationStatus: true, receivedAt: true, reversed: true, reversedAt: true, createdAt: true,
} satisfies Prisma.PaymentSelect
type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>

export function toApiPayment(p: PaymentRow) {
  return {
    id: p.id,
    loanId: p.loanId,
    amountCents: p.amount,
    paymentMethod: p.paymentMethod,
    reference: p.reference,
    allocationStatus: p.allocationStatus,
    receivedAt: p.receivedAt.toISOString(),
    reversed: p.reversed,
    reversedAt: iso(p.reversedAt),
    createdAt: p.createdAt.toISOString(),
  }
}
