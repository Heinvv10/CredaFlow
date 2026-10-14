"use client"

import type { NonNcaArrearsValues } from "@/lib/product-config/non-nca-arrears-form"

/**
 * The arrears terms an asset-finance (NON_NCA) agreement booked on this product
 * copies at booking. Never applied to an NCA loan, whose caps and s129 rules
 * hold. Shown only when the tenant has asset finance on.
 */
export function NonNcaArrearsFields({ values, onChange }: { values: NonNcaArrearsValues; onChange: (next: NonNcaArrearsValues) => void }) {
  const input = "w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] focus:border-[var(--cf-brand)] focus:outline-none"
  const label = "mb-1 block text-sm font-medium text-[var(--cf-text)]"
  return (
    <div className="space-y-4 rounded-2xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">Asset finance arrears (NON_NCA agreements only)</p>
        <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
          Copied onto each asset-finance agreement when it is booked, so a later change here does not reprice a signed agreement.
          Leave a field empty for none.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="nonNcaMargin" className={label}>Default-interest margin (% a year)</label>
          <input id="nonNcaMargin" type="text" inputMode="decimal" className={input} placeholder="2" value={values.marginPercent}
            onChange={(e) => onChange({ ...values, marginPercent: e.target.value })} />
          <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">Charged on overdue amounts on top of the contract rate.</p>
        </div>
        <div>
          <label htmlFor="nonNcaFee" className={label}>Collection fee per missed instalment (R)</label>
          <input id="nonNcaFee" type="text" inputMode="decimal" className={input} placeholder="250.00" value={values.feeRand}
            onChange={(e) => onChange({ ...values, feeRand: e.target.value })} />
        </div>
      </div>
    </div>
  )
}
