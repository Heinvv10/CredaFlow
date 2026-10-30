"use client"

import Link from "next/link"
import { useEffect, type ReactNode } from "react"
import { ArrowRight, CheckCircle, RotateCcw, ShieldAlert } from "lucide-react"
import { calculateLoan, formatZAR } from "@/lib/loan-calculator"
import type { LoanCalcInput } from "@/lib/loan-calculator"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { trackQualifyResult } from "@/lib/analytics/events"
import { useT } from "@/lib/i18n/client"
import { termText } from "@/lib/i18n/products"
import {
  getPublicLoanProduct,
  microMaxRands,
  productForAmount,
  qualifyAmountBoundsRands,
  qualifyApplyHref,
  type PublicLoanProduct,
} from "@/lib/public-loan-products"

interface ResultProps {
  incomeCents: number
  expensesCents: number
  amountRands: number
  termValue: number
  // Live-overlaid product catalogue from the page, so the pricing + boundary
  // track the admin's LoanProduct config (fail-open to the static catalogue).
  products: PublicLoanProduct[]
  onRestart: () => void
}

// Micro (<= the live short-term max) uses short-term product pricing; larger
// amounts use personal-loan pricing. Fees come from the LIVE product (fail-open
// to the static catalogue via getPublicLoanProduct), so the pre-qual estimate
// matches what the borrower is actually charged.
function feeFieldsForAmount(products: PublicLoanProduct[], amountCents: number, microMax: number) {
  const code = amountCents <= microMax * 100 ? "short-term" : "personal"
  const product = products.find((p) => p.code === code) ?? getPublicLoanProduct(code)
  return {
    interestRatePm: product.interestRatePm,
    productType: product.productType ?? null,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
  }
}

function buildLoanInput(
  amountCents: number,
  termDays: number,
  products: PublicLoanProduct[],
  microMax: number,
): LoanCalcInput {
  return {
    principal: amountCents,
    termDays,
    ...feeFieldsForAmount(products, amountCents, microMax),
  }
}

function findMaxAffordable(
  ndiCents: number,
  termValue: number,
  isMicro: boolean,
  products: PublicLoanProduct[],
  microMax: number,
  ceilingRands: number,
): number {
  const maxInstalment = Math.floor(ndiCents * 0.7)
  // Search down from the live micro max (micro) or personal ceiling (in cents)
  // so the suggested lower amount tracks the wizard's real range.
  let testAmount = isMicro ? microMax * 100 : ceilingRands * 100

  while (testAmount >= 50000) {
    // termValue is canonical DAYS (same unit regardless of tier).
    const input = buildLoanInput(testAmount, termValue, products, microMax)
    const result = calculateLoan(input)
    if (result.monthlyInstalment <= maxInstalment) {
      return testAmount
    }
    testAmount -= isMicro ? 10000 : 50000
  }
  return 0
}

export default function QualifyResult({
  incomeCents,
  expensesCents,
  amountRands,
  termValue,
  products,
  onRestart,
}: ResultProps) {
  const identity = useWebsiteIdentity()
  const t = useT("websiteQualify")
  const tp = useT("websiteProducts")
  // Micro/personal via the SHARED productForAmount rule (so the pre-qual prices the
  // same product the apply form will route to); microMax/ceiling (RANDS, fail-open
  // to static) feed the internal fee-selection + affordability search, which use
  // the same boundary productForAmount does.
  const microMax = microMaxRands(products)
  const ceilingRands = qualifyAmountBoundsRands(products).max
  const ndiCents = incomeCents - expensesCents
  const amountCents = amountRands * 100
  const isMicro = productForAmount(amountRands, products) === "MICRO"
  // termValue is canonical DAYS; display it in the tier's unit.
  const termDays = termValue
  const termLabel = isMicro
    ? termText(tp, { termUnit: "days" }, termValue)
    : termText(tp, { termUnit: "months" }, Math.round(termValue / 30))

  const input = buildLoanInput(amountCents, termDays, products, microMax)
  const result = calculateLoan(input)
  const maxInstalment = Math.floor(ndiCents * 0.7)
  const affordable = result.monthlyInstalment <= maxInstalment
  const missingIncome = incomeCents <= 0

  const maxAmount = !affordable
    ? findMaxAffordable(ndiCents, termValue, isMicro, products, microMax, ceilingRands)
    : 0

  // Funnel instrumentation (R0-2): fires whenever the computed outcome
  // changes (initial render, or a recalculation flipping the verdict).
  const outcome = missingIncome ? "incomplete" : affordable ? "qualified" : "declined"
  useEffect(() => {
    trackQualifyResult(outcome)
  }, [outcome])

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.32)] md:p-7">
        <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-[#a5b4fc]/80 to-transparent" />
        {missingIncome ? (
          <ResultHeader
            icon={<ShieldAlert size={34} />}
            eyebrow={t("incompleteEyebrow")}
            title={t("incompleteTitle")}
            body={t("incompleteBody")}
            tone="amber"
          />
        ) : affordable ? (
          <ResultHeader
            icon={<CheckCircle size={34} />}
            eyebrow={t("qualifiedEyebrow")}
            title={t("qualifiedTitle")}
            body={t("qualifiedBody")}
            tone="gold"
          />
        ) : (
          <ResultHeader
            icon={<ShieldAlert size={34} />}
            eyebrow={t("reviewEyebrow")}
            title={t("reviewTitle")}
            body={t("reviewBody")}
            tone="amber"
          />
        )}

        {!missingIncome && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Metric label={t("estimatedInstalment")} value={formatZAR(result.monthlyInstalment)} highlight />
            <Metric label={t("affordabilityThreshold")} value={formatZAR(maxInstalment)} />
            <Metric label={t("requestedAmount")} value={formatZAR(amountCents)} />
          </div>
        )}

        {!missingIncome && (
          <div className="mt-5 space-y-2">
            <Row label={t("term")} value={termLabel} />
            <Row label={t("totalInterest")} value={formatZAR(result.totalInterest)} />
            <Row label={t("initiationFee")} value={formatZAR(result.initiationFee)} />
            {result.serviceFees > 0 && (
              <Row label={t("serviceFees")} value={formatZAR(result.serviceFees)} />
            )}
            <Row label={t("totalRepayable")} value={formatZAR(result.totalRepayable)} bold />
          </div>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {affordable && !missingIncome && (
            <Link
              // Shared handoff builder classifies the amount it carries via the
              // shared tiering rule + emits an explicit product, so apply applies
              // under the SAME product the wizard priced (no static-vs-live drift).
              href={qualifyApplyHref(amountCents, termValue, products)}
              className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-4 py-3 text-center text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe]"
            >
              {t("applyFor", { amount: formatZAR(amountCents) })}
              <ArrowRight size={16} />
            </Link>
          )}
          {!affordable && !missingIncome && maxAmount > 0 && (
            <Link
              // Same builder, but for the SUGGESTED lower amount — which can be a
              // different tier than the requested one (the affordability search
              // crosses the boundary), so it is classified independently.
              href={qualifyApplyHref(maxAmount, termValue, products)}
              className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-4 py-3 text-center text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe]"
            >
              {t("applyFor", { amount: formatZAR(maxAmount) })}
              <ArrowRight size={16} />
            </Link>
          )}
          <button
            onClick={onRestart}
            className="inline-flex items-center justify-center gap-2 border border-white/18 px-4 py-3 text-sm font-bold text-white/72 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            <RotateCcw size={16} />
            {t("recalculate")}
          </button>
        </div>
      </div>

      <p className="text-center text-[11px] leading-relaxed text-white/42">
        This is a pre-qualification estimate only. Final approval is subject to a full credit and
        affordability assessment as required by the National Credit Act (NCA) No. 34 of 2005.
        {identity.legalName} — Registered Credit Provider{identity.ncrNumber ? <> (NCR Reg: {identity.ncrNumber})</> : null}.
      </p>

    </div>
  )
}

function ResultHeader({
  icon,
  eyebrow,
  title,
  body,
  tone,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  body: string
  tone: "gold" | "amber"
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
      <div
        className={`flex h-16 w-16 items-center justify-center border ${
          tone === "gold"
            ? "border-[#a5b4fc]/45 bg-[#a5b4fc]/12 text-[#a5b4fc]"
            : "border-orange-300/40 bg-orange-300/10 text-orange-200"
        }`}
      >
        {icon}
      </div>
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{eyebrow}</p>
        <h3 className="text-2xl font-semibold text-white">{title}</h3>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">{body}</p>
      </div>
    </div>
  )
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="border border-white/10 bg-black/18 p-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-white/38">{label}</p>
      <p className={`text-lg font-bold ${highlight ? "text-[#a5b4fc]" : "text-white"}`}>{value}</p>
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between border px-3 py-2 ${
        bold
          ? "border-[#a5b4fc]/25 bg-[#a5b4fc]/10 font-bold text-[#a5b4fc]"
          : "border-white/8 bg-black/18 text-sm text-white/62"
      }`}
    >
      <span className={bold ? "text-white/70" : ""}>{label}</span>
      <span>{value}</span>
    </div>
  )
}
