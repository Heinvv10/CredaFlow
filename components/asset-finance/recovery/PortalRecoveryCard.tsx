import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatMoney } from "@/lib/asset-finance/format"
import type { PortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import { formatDay } from "@/lib/i18n/format"
import type { Locale } from "@/lib/i18n/locales"
import { portalRecovery } from "@/lib/i18n/messages/en/portal-recovery"
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate"
import { STATUS_LABELS, TREATMENT_LABELS } from "./recovery-model"

type Key = MessageKey<"portalRecovery">

// Enum values arrive as strings at runtime; one not in the catalogue falls back
// to the English label the card printed before, rather than throwing.
const KEYS: ReadonlySet<string> = new Set(Object.keys(portalRecovery))
const isKey = (key: string): key is Key => KEYS.has(key)
const label = (t: Translator<"portalRecovery">, key: string, english: string): string => (isKey(key) ? t(key) : english)

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
 * In the borrower's language (lib/i18n, namespace portalRecovery); cost names
 * and money stay English, as on the s127 final notice.
 */
export function PortalRecoveryCard({ view, locale }: { view: PortalRecoveryView; locale: Locale }) {
  const t = createTranslator(locale, "portalRecovery")
  // Noon SAST: the calendar day cannot shift in any time zone conversion.
  const day = (iso: string) => formatDay(`${iso}T12:00:00+02:00`, locale)
  const account = view.finalAccount
  const notices = [view.notices.valuation ? t("noticeValuation") : null, view.notices.final ? t("noticeFinal") : null].filter(Boolean)
  const tone = view.status === "WITHDRAWN" ? "neutral" : view.status === "SHORTFALL_OPEN" ? "danger" : view.status === "CLOSED" ? "success" : "warning"
  return (
    <DataPanel title={t("title")} description={t("description", { asset: view.asset, date: day(view.recoveredOn) })}
      actions={<StatusPill tone={tone}>{label(t, `status_${view.status}`, STATUS_LABELS[view.status])}</StatusPill>}>
      <div className="space-y-5 text-sm">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {/* The server withholds the valuation until the borrower may see it: absent says nothing, so nothing is printed. */}
          {view.valuationAmountCents !== null && <Figure label={t("valuation")} value={formatMoney(view.valuationAmountCents)} />}
          <Figure label={t("noticesIssued")} value={notices.length > 0 ? notices.join(", ") : t("noneYet")} />
        </dl>
        {account && (
          <>
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <Figure label={t("saleProceeds")} value={formatMoney(account.grossProceedsCents)} />
              <Figure label={t("deductedCosts")} value={formatMoney(account.deductedCostsCents)} />
              <Figure label={t("netProceeds")} value={formatMoney(account.netProceedsCents)} strong />
              <Figure label={t("chargedCosts")} value={formatMoney(account.chargedCostsCents)} />
              {account.unrecoverableCostsCents > 0 && <Figure label={t("unrecoverableCosts")} value={formatMoney(account.unrecoverableCostsCents)} />}
              {account.shortfallCents > 0 && <Figure label={t("shortfall")} value={formatMoney(account.shortfallCents)} strong />}
              {account.surplusCents > 0 && <Figure label={t("surplus")} value={formatMoney(account.surplusCents)} strong />}
              {account.shortfallCents === 0 && account.surplusCents === 0 && <Figure label={t("balance")} value={t("nothingOwed")} strong />}
            </dl>
            {account.chargesFrozenUntil && (
              <p className="text-xs text-[var(--cf-text-muted)]">{t("chargesFrozenUntil", { date: day(account.chargesFrozenUntil) })}</p>
            )}
            {account.costs.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]">{t("recoveryCosts")}</p>
                <ul className="divide-y divide-[var(--cf-border-subtle)]">
                  {account.costs.map((cost, index) => (
                    <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                      <span className="min-w-0 text-[var(--cf-text)]">{cost.label}<span className="block text-xs text-[var(--cf-text-muted)]">{label(t, `treatment_${cost.treatment}`, TREATMENT_LABELS[cost.treatment])}</span></span>
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
