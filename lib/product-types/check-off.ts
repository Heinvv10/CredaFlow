/**
 * The month's deduction list a salary-backed lender sends each employer (spec 2.1.1): every instalment due in the month on an
 * active salary-backed loan, unpaid part included, by employer. Outbound only: importing what the employer actually remitted,
 * and matching it (2.6.3), is not built, so a receipt is captured against each loan as any other payment.
 */
import type { prisma } from "@/lib/prisma"
import { SAST_OFFSET_MS } from "@/lib/date/sast"

export interface DeductionRow {
  employer: string
  payrollNumber: string
  borrower: string
  loanReference: string
  dueDate: string
  amountCents: number
}

type Db = Pick<typeof prisma, "repaymentSchedule">

/** The SAST calendar month `YYYY-MM` as a half-open range of instants. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) return null
  const [year, index] = [Number(match[1]), Number(match[2]) - 1]
  return { from: new Date(Date.UTC(year, index, 1) - SAST_OFFSET_MS), to: new Date(Date.UTC(year, index + 1, 1) - SAST_OFFSET_MS) }
}

export async function loadDeductions(db: Db, tenantId: string, month: string): Promise<DeductionRow[] | null> {
  const range = monthRange(month)
  if (!range) return null
  const rows = await db.repaymentSchedule.findMany({
    where: {
      tenantId, dueDate: { gte: range.from, lt: range.to }, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
      loan: { tenantId, status: "ACTIVE", product: { productType: "SALARY_BACKED" } },
    },
    orderBy: { dueDate: "asc" },
    select: {
      dueDate: true, totalDue: true, totalPaid: true,
      loan: { select: { reference: true, client: { select: { firstName: true, lastName: true } }, application: { select: { productFacts: { select: { employerName: true, payrollNumber: true } } } } } },
    },
  })
  const deductions = rows.map((row) => ({
    employer: row.loan.application.productFacts?.employerName ?? "No employer recorded", payrollNumber: row.loan.application.productFacts?.payrollNumber ?? "",
    borrower: `${row.loan.client?.firstName ?? ""} ${row.loan.client?.lastName ?? ""}`.trim(), loanReference: row.loan.reference,
    dueDate: new Date(row.dueDate.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10), amountCents: row.totalDue - row.totalPaid,
  }))
  return deductions.sort((a, b) => a.employer.localeCompare(b.employer) || a.borrower.localeCompare(b.borrower))
}

/** A cell a spreadsheet will not run: a leading =, +, - or @ is a formula. */
const cell = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`

export function deductionsCsv(rows: DeductionRow[]): string {
  const lines = rows.map((r) => [r.employer, r.payrollNumber, r.borrower, r.loanReference, r.dueDate, (r.amountCents / 100).toFixed(2)].map(cell).join(","))
  return ["employer,payroll_number,borrower,loan_reference,due_date,amount", ...lines].join("\r\n") + "\r\n"
}
