import { redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireMinRole } from "@/lib/auth-guards"
import { sastCalendarDate } from "@/lib/date/sast"
import { activeCurrency } from "@/lib/jurisdiction/active"
import { formatMoney } from "@/lib/jurisdiction/money"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { loadDeductions } from "@/lib/product-types/check-off"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = { title: "Check-off deductions — Settings" }

/** The month's deduction list for salary-backed loans, by employer. What an employer remitted is captured against each loan: there is no payroll file import yet. */
export default async function CheckOffPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requireMinRole("CREDIT_OFFICER")
  if (!canDo(user.role, "view_check_off_deductions")) redirect("/settings")
  const asked = (await searchParams).month
  const month = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : sastCalendarDate(new Date()).slice(0, 7)
  const rows = (await loadDeductions(prisma, await getStaffTenantId(), month)) ?? []
  const currency = activeCurrency()
  const total = rows.reduce((a, r) => a + r.amountCents, 0)
  return (
    <>
      <Header
        title="Check-off deductions"
        subtitle="What each employer deducts this month for salary-backed loans. Receipts are captured per loan: importing a payroll file is not built yet."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Products", href: "/settings/products" }, { label: "Check-off deductions" }]}
      />
      <div className="p-4 lg:p-8 max-w-5xl space-y-4">
        <form className="flex items-end gap-3 text-sm">
          <label className="space-y-1">Month<input type="month" name="month" defaultValue={month} className="block rounded border border-[var(--cf-border-subtle)] px-2 py-1" /></label>
          <button type="submit" className="rounded border border-[var(--cf-border-subtle)] px-3 py-1">Show</button>
          <a className="underline" href={`/api/products/check-off/deductions?month=${month}&format=csv`}>Download CSV</a>
        </form>
        {rows.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No salary-backed instalment is due in {month}.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Employer</TableHead><TableHead>Payroll number</TableHead><TableHead>Borrower</TableHead><TableHead>Loan</TableHead><TableHead>Due</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => <TableRow key={`${r.loanReference}-${r.dueDate}`}><TableCell>{r.employer}</TableCell><TableCell>{r.payrollNumber}</TableCell><TableCell>{r.borrower}</TableCell><TableCell>{r.loanReference}</TableCell><TableCell>{r.dueDate}</TableCell><TableCell className="text-right">{formatMoney(r.amountCents, currency)}</TableCell></TableRow>)}
              <TableRow><TableCell colSpan={5} className="font-semibold">Total</TableCell><TableCell className="text-right font-semibold">{formatMoney(total, currency)}</TableCell></TableRow>
            </TableBody>
          </Table>
        )}
      </div>
    </>
  )
}
