/**
 * Records the date a loan left the book, for a loan in a terminal status (COMPLETED, CANCELLED, WRITTEN_OFF) whose date
 * is missing. The IFRS 9 close refuses such a loan (IFRS9_EXIT_UNDATED) because it cannot say which month releases its
 * allowance. Only ever fills a missing date: a date already recorded is never changed. Audited.
 */
import type { PrismaClient } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditDb } from "./audit-db"

export type ExitDateRefusalCode = "INVALID_DATE" | "FUTURE_DATE" | "REASON_REQUIRED" | "TENANT_NOT_FOUND" | "LOAN_NOT_FOUND" | "NOT_UNDATED" | "PERIOD_CLOSED"

export class ExitDateRefusal extends Error {
  constructor(readonly code: ExitDateRefusalCode, message: string) {
    super(message)
    this.name = "ExitDateRefusal"
  }
}

export interface ExitDateInput {
  tenantSlug: string
  loanReference: string
  /** yyyy-mm-dd, a SAST calendar day. */
  date: string
  reason: string
  /** Who ran the CLI (OS user @ host), recorded in the audit row. */
  operator: string
  now?: Date
}

const SOURCE = "lender:set-exit-date"
const TERMINAL = ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] as const

export async function setLoanExitDate(db: PrismaClient, input: ExitDateInput): Promise<{ loanId: string; field: "closedAt" | "writeOffAt"; date: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(new Date(`${input.date}T12:00:00+02:00`).getTime())) {
    throw new ExitDateRefusal("INVALID_DATE", `"${input.date}" is not a date, yyyy-mm-dd`)
  }
  if (input.reason.trim().length < 5) throw new ExitDateRefusal("REASON_REQUIRED", "A reason of at least 5 characters is required: it is kept in the audit trail")
  const when = new Date(`${input.date}T12:00:00+02:00`)
  if (when.getTime() > (input.now ?? new Date()).getTime()) throw new ExitDateRefusal("FUTURE_DATE", `${input.date} is in the future`)

  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { slug: input.tenantSlug }, select: { id: true } })
    if (!tenant) throw new ExitDateRefusal("TENANT_NOT_FOUND", `No tenant with slug "${input.tenantSlug}"`)
    const loan = await tx.loan.findFirst({
      where: { tenantId: tenant.id, reference: input.loanReference }, select: { id: true, status: true, closedAt: true, writeOffAt: true },
    })
    if (!loan) throw new ExitDateRefusal("LOAN_NOT_FOUND", `No loan ${input.loanReference} in tenant "${input.tenantSlug}"`)
    const field = loan.status === "WRITTEN_OFF" ? "writeOffAt" : "closedAt"
    if (!(TERMINAL as readonly string[]).includes(loan.status) || loan[field] !== null) {
      throw new ExitDateRefusal("NOT_UNDATED", `${input.loanReference} is ${loan.status} with ${field} ${loan[field] ? "already recorded" : "not applicable"}: only a missing date is filled in`)
    }
    // A closed accounting month held the loan on the book: an exit dated inside it would contradict the ledger.
    const closed = await tx.accountingExportBatch.findFirst({ where: { tenantId: tenant.id, periodKey: { gte: input.date.slice(0, 7) } }, select: { periodKey: true } })
    if (closed) throw new ExitDateRefusal("PERIOD_CLOSED", `${closed.periodKey} is closed and held the loan: the exit cannot be dated ${input.date}`)
    await tx.loan.update({ where: { id: loan.id }, data: { [field]: when } })
    await logAuditStrict({
      tenantId: tenant.id, userEmail: SOURCE, action: AuditAction.IFRS9_LOAN_EXIT_DATE_SET, entity: "Loan", entityId: loan.id,
      oldValue: { [field]: null }, newValue: { [field]: input.date, reason: input.reason.trim(), operator: input.operator },
    }, auditDb(tx))
    return { loanId: loan.id, field, date: input.date }
  })
}
