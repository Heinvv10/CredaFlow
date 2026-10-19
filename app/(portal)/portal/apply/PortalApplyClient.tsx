"use client"

import Link from "next/link"
import { Zap, Star, Briefcase, AlertTriangle } from "lucide-react"
import { formatZAR } from "@/lib/utils"
import type { QualificationBounds, QualificationResult } from "@/lib/qualify"
import { useT } from "@/lib/i18n/client"
import { ExploreCalculator, ndiColor } from "./ExploreCalculator"
import { OwnArrearsNotice, type OwnArrears } from "./OwnArrearsNotice"

interface ClientData {
  firstName: string
  monthlyIncome: number   // cents
  monthlyExpenses: number // cents
  existingDebt: number    // cents
}

type ProductKey = "micro" | "personal" | "po"

/** The client's latest application declined within RECENT_DECLINE_DAYS (page.tsx). */
export interface RecentDecline {
  id: string
  reference: string
  decidedOn: string
}

interface Props {
  client: ClientData | null
  qualification: QualificationResult | null
  // Live amount-range strings ("R500 – R10,000") per product, resolved server-side
  // from the LoanProduct rows (fail-open to static) so the copy tracks the admin.
  productRanges: Record<ProductKey, string>
  /** Live product amount ranges, so no figure here exceeds what a product lends. */
  bounds: QualificationBounds
  recentDecline: RecentDecline | null
  /** Worst days late and total overdue across the client's loans with this lender, or null when up to date. */
  ownLenderArrears: OwnArrears | null
}

function AffordabilityCard({ client, qual }: { client: ClientData; qual: QualificationResult | null }) {
  const t = useT("portalApply")
  const incomplete = client.monthlyIncome === 0

  return (
    <div className="mb-6 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-6 text-[var(--cf-text)]">
      <h2 className="text-lg font-bold mb-4">{t("myAffordability")}</h2>

      {incomplete && (
        <div
          className="flex items-start gap-3 rounded-lg p-4 mb-4 text-sm"
          style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b" }}
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
          <span className="text-[var(--cf-text-secondary)]">
            {t("completeProfile")}{" "}
            <Link href="/portal/profile" className="underline" style={{ color: "#4338CA" }}>
              {t("updateProfileLink")}
            </Link>
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        {[
          { label: t("monthlyIncome"), value: formatZAR(client.monthlyIncome) },
          { label: t("monthlyExpenses"), value: formatZAR(client.monthlyExpenses) },
          { label: t("existingDebt"), value: formatZAR(client.existingDebt) },
        ].map(({ label, value }) => (
          <div key={label}>
            <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">{label}</p>
            <p className="font-semibold text-[var(--cf-text)]">{value}</p>
          </div>
        ))}
        <div>
          <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">{t("ndiFull")}</p>
          <p
            className="font-bold text-base"
            style={{ color: qual ? ndiColor(qual.ndi) : "#6b7280" }}
          >
            {qual ? formatZAR(qual.ndi) : "—"}
          </p>
        </div>
        <div>
          <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">{t("maxInstalmentNdi")}</p>
          <p className="font-semibold" style={{ color: "#4F46E5" }}>
            {qual ? formatZAR(qual.maxInstalment) : "—"}
          </p>
        </div>
      </div>
    </div>
  )
}

// `range` is injected live per product (see productRanges), not hardcoded.
const PRODUCTS = [
  {
    key: "micro" as const,
    icon: Zap,
    title: "microTitle",
    subtitle: "microSubtitle",
    paymentLabel: "microPayment",
  },
  {
    key: "personal" as const,
    icon: Star,
    title: "personalTitle",
    subtitle: "personalSubtitle",
    paymentLabel: "personalPayment",
  },
  {
    key: "po" as const,
    icon: Briefcase,
    title: "poTitle",
    subtitle: "poSubtitle",
    paymentLabel: "poPayment",
  },
] as const

function RecentDeclineNotice({ decline }: { decline: RecentDecline }) {
  const t = useT("portalApply")
  return (
    <div
      className="flex items-start gap-3 rounded-lg p-4 mb-6 text-sm"
      style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b", color: "var(--cf-text-secondary)" }}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
      <div>
        <p className="font-semibold text-[var(--cf-text)]">{t("recentDeclineTitle")}</p>
        <p className="mt-1">{t("recentDeclineBody", { reference: decline.reference, date: decline.decidedOn })}</p>
        <Link href={`/portal/applications/${decline.id}`} className="underline" style={{ color: "#4338CA" }}>
          {t("recentDeclineLink")}
        </Link>
      </div>
    </div>
  )
}

// `qual` is null when there is nothing to recommend: no profile income, or a
// recent decline (an affordability estimate is not an offer to someone just
// declined). PO funding shows its configured range, not the qualification
// helper's interest-only proxy: review assesses the full scheduled repayment.
function ProductCards({ qual, productRanges }: { qual: QualificationResult | null; productRanges: Record<ProductKey, string> }) {
  const t = useT("portalApply")
  const amounts = {
    micro: qual?.microLoan.maxAmount ?? 0,
    personal: qual?.personalLoan.maxAmount ?? 0,
    po: 0,
  }
  const payments = {
    micro: qual?.microLoan.totalRepayable ?? 0,
    personal: qual?.personalLoan.monthlyInstalment ?? 0,
    po: 0,
  }

  return (
    <div className="mb-6">
      <h2 className="text-lg font-bold text-gray-900 mb-4">{t("whatYouQualifyFor")}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PRODUCTS.map(({ key, icon: Icon, title, subtitle, paymentLabel }) => {
          const amount = amounts[key]
          const payment = payments[key]
          const featured = key === "personal" && qual !== null
          const sized = qual !== null && key !== "po"

          return (
            <div
              key={key}
              className="bg-white rounded-xl shadow-sm overflow-hidden flex flex-col"
              style={{ border: `${featured ? 2 : 1}px solid ${featured ? "#4F46E5" : "#e5e7eb"}` }}
            >
              {featured && (
                <div className="py-1.5 text-center text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: "#4F46E5" }}>
                  {t("bestMatch")}
                </div>
              )}
              <div className="p-5 flex flex-col flex-1">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center mb-3 border border-[var(--cf-border-subtle)]"
                    style={{ backgroundColor: featured ? "#4F46E5" : "var(--cf-bg-raised)" }}
                  >
                  <Icon className="h-4 w-4" style={{ color: featured ? "#fff" : "#4F46E5" }} />
                </div>
                <h3 className="text-sm font-bold text-gray-900 mb-0.5">{t(title)}</h3>
                <p className="text-[11px] text-gray-500 mb-3">{t(subtitle)}</p>

                {sized ? (
                  amount > 0 ? (
                    <>
                      <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-0.5">{t("qualifyUpTo")}</p>
                      <p className="text-xl font-bold mb-1" style={{ color: "#4F46E5" }}>{formatZAR(amount)}</p>
                      <p className="text-[12px] text-gray-500 mb-4">
                        {t(paymentLabel)}: <span className="font-semibold text-gray-700">{formatZAR(payment)}</span>
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-gray-400 mb-4 flex-1">{t("belowMinimum")}</p>
                  )
                ) : (
                  <>
                    <p className="text-[11px] text-gray-400 mb-0.5">{t("range")}</p>
                    <p className="text-sm font-semibold text-gray-700 mb-4">{productRanges[key]}</p>
                    {key === "po" && <p className="text-[12px] text-gray-500 mb-4">{t("poBusinessOnly")}</p>}
                  </>
                )}

                {sized && amount === 0 ? null : (
                  <div className="mt-auto">
                    <Link
                      href={`/portal/apply/${key}`}
                      className="block text-center py-2.5 rounded-lg text-sm font-semibold transition-colors"
                        style={featured
                          ? { backgroundColor: "#4F46E5", color: "var(--cf-on-brand)" }
                          : { backgroundColor: "var(--cf-bg-raised)", color: "#4338CA", border: "1px solid var(--cf-border-subtle)" }}
                    >
                      {t("applyFor", { product: t(key === "po" ? "poFunding" : title) })}
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function PortalApplyClient({ client, qualification, productRanges, bounds, recentDecline, ownLenderArrears }: Props) {
  const t = useT("portalApply")
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {client && !recentDecline ? t("greeting", { name: client.firstName }) : t("qualifyApply")}
        </h1>
        <p className="text-sm text-gray-500 mt-1">{t("personalised")}</p>
      </div>

      {recentDecline && <RecentDeclineNotice decline={recentDecline} />}
      {ownLenderArrears && <OwnArrearsNotice arrears={ownLenderArrears} />}

      {client ? (
        <AffordabilityCard client={client} qual={qualification} />
      ) : (
          <div className="rounded-xl border border-[var(--cf-border-subtle)] p-5 mb-6 text-sm text-[var(--cf-text-muted)]" style={{ borderLeft: "3px solid #4F46E5" }}>
          {t("loginForResults")}
        </div>
      )}

      <ProductCards qual={recentDecline ? null : qualification} productRanges={productRanges} />

      <ExploreCalculator client={client} bounds={bounds} />
    </div>
  )
}
