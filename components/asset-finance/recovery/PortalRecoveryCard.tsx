import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { PortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import { formatDay } from "@/lib/i18n/format"
import type { Locale } from "@/lib/i18n/locales"
import { portalRecovery } from "@/lib/i18n/messages/en/portal-recovery"
import { createTranslator, type MessageKey } from "@/lib/i18n/translate"
import { STATUS_LABELS, TREATMENT_LABELS } from "./recovery-model"

// Only a status with a portalRecovery key is translated. The rest (the notice,
// shortfall and surplus statuses) and any value the catalogue does not know
// print the English label: lib/i18n/messages/en/portal-recovery.ts says why.
const KEYS: ReadonlySet<string> = new Set(Object.keys(portalRecovery))
const isKey = (key: string): key is MessageKey<"portalRecovery"> => KEYS.has(key)

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className={`whitespace-nowrap tabular-nums text-[var(--cf-text)] ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  )
}

/**
 * The borrower's view of the recovery of their asset: where it stands, which
 * notices have been issued, and, once the account is final, what the sale
 * raised, the costs and the shortfall or surplus. Never the buyer or the sale.
 * The heading and neutral statuses are in the borrower's language; every line
 * that mirrors the s127/s131 notices or states what is owed stays English.
 */
export function PortalRecoveryCard({ view, locale }: { view: PortalRecoveryView; locale: Locale }) {
  const t = createTranslator(locale, "portalRecovery")
  const statusKey = `status_${view.status}`
  const account = view.finalAccount
  const notices = [view.notices.valuation ? "Valuation notice" : null, view.notices.final ? "Final notice" : null].filter(Boolean)
  const tone = view.status === "WITHDRAWN" ? "neutral" : view.status === "SHORTFALL_OPEN" ? "danger" : view.status === "CLOSED" ? "success" : "warning"
  return (
    <DataPanel title={t("title")} description={t("description", { asset: view.asset, date: formatDay(`${view.recoveredOn}T12:00:00+02:00`, locale) })}
      actions={<StatusPill tone={tone}>{isKey(statusKey) ? t(statusKey) : STATUS_LABELS[view.status]}</StatusPill>}>
      <div className="space-y-5 text-sm">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {/* The server withholds the valuation until the borrower may see it: absent says nothing, so nothing is printed. */}
          {view.valuationAmountCents !== null && <Figure label="Valuation" value={formatMoney(view.valuationAmountCents)} />}
          <Figure label={t("noticesIssued")} value={notices.length > 0 ? notices.join(", ") : t("noneYet")} />
        </dl>
        {account && (
          <>
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Figure label="Sale proceeds" value={formatMoney(account.grossProceedsCents)} />
              <Figure label="Costs deducted from the proceeds" value={formatMoney(account.deductedCostsCents)} />
              <Figure label="Net proceeds" value={formatMoney(account.netProceedsCents)} strong />
              <Figure label="Costs charged to the account" value={formatMoney(account.chargedCostsCents)} />
              {account.unrecoverableCostsCents > 0 && <Figure label="Charged costs not recoverable on the account" value={formatMoney(account.unrecoverableCostsCents)} />}
              {account.shortfallCents > 0 && <Figure label="Shortfall you owe" value={formatMoney(account.shortfallCents)} strong />}
              {account.surplusCents > 0 && <Figure label="Surplus due to you" value={formatMoney(account.surplusCents)} strong />}
              {account.shortfallCents === 0 && account.surplusCents === 0 && <Figure label="Balance" value="Nothing owed either way" strong />}
            </dl>
            {account.chargesFrozenUntil && (
              <p className="text-xs text-[var(--cf-text-muted)]">No further charges accrue on the account until {formatIsoDate(account.chargesFrozenUntil)}.</p>
            )}
            {account.costs.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]">Recovery costs</p>
                <ul className="divide-y divide-[var(--cf-border-subtle)]">
                  {account.costs.map((cost, index) => (
                    <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                      <span className="min-w-0 text-[var(--cf-text)]">{cost.label}<span className="block text-xs text-[var(--cf-text-muted)]">{TREATMENT_LABELS[cost.treatment]}</span></span>
                      <span className="whitespace-nowrap font-semibold tabular-nums text-[var(--cf-text)]">{formatMoney(cost.grossCents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </DataPanel>
  )
}
