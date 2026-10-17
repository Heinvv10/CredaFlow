import { OWN_LOAN_SOURCE_PREFIX, withOwnLenderDebts, type OwnLenderDebts } from "@/lib/affordability/own-lender-debt"
import { formatZAR } from "@/lib/utils"

/**
 * The obligations to this lender the affordability preview adds to the
 * declared rows, exactly as the server does (lib/affordability/own-lender-debt.ts):
 * the rows, and their monthly total.
 */
export function ownLenderPreview(debts: Parameters<typeof withOwnLenderDebts>[0], own: OwnLenderDebts | null) {
  const rows = own ? withOwnLenderDebts(debts, own).filter((debt) => debt.sourceId?.startsWith(OWN_LOAN_SOURCE_PREFIX)) : []
  return { rows, instalments: rows.reduce((sum, debt) => sum + Number(debt.monthlyInstalmentCents ?? 0), 0) }
}

/** "Loans with us (counted automatically)" under the declared obligations. */
export function OwnLenderDebtRows({ debts, own }: { debts: Parameters<typeof withOwnLenderDebts>[0]; own: OwnLenderDebts | null }) {
  const { rows } = ownLenderPreview(debts, own)
  if (rows.length === 0) return null
  return (
    <div data-testid="own-lender-debts">
      <p className="mb-2 text-sm font-semibold text-[var(--cf-text-secondary)]">Loans with us (counted automatically)</p>
      <div className="space-y-1 text-xs text-[var(--cf-text-secondary)]">
        {rows.map((debt) => (
          <div key={debt.sourceId} className="flex justify-between gap-3 rounded border border-[var(--cf-border-subtle)] px-2.5 py-1.5">
            <span>{debt.notes}</span>
            <span className="whitespace-nowrap font-semibold">{formatZAR(Number(debt.monthlyInstalmentCents ?? 0))} / month</span>
          </div>
        ))}
      </div>
    </div>
  )
}
