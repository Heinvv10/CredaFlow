"use client"

import { useState } from "react"
import { calculateLoan, formatZAR } from "@/lib/loan-calculator"
import type { LoanCalcResult } from "@/lib/loan-calculator"
import {
  applyLivePricing,
  formatProductRange,
  getPublicLoanProduct,
  getTermDays,
  type PublicLoanProduct,
} from "@/lib/public-loan-products"
import { useLivePricing } from "@/lib/use-live-pricing"

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

type Limits = { minAmount: number; maxAmount: number; minTermDays: number; maxTermDays: number }

// Real product limits (cents / days) derived from the LIVE product (fail-open to
// static). The compare only quotes each product within the range it can actually
// be originated at, and only declares a "cheaper" winner when BOTH products
// can serve the selected amount AND term. Personal loans start at 3 months, so
// below 90 days the personal card is shown as unavailable rather than fed a
// degenerate 0-month schedule that dropped the initiation fee.
function limitsFor(p: PublicLoanProduct): Limits {
  return {
    minAmount: p.minAmount,
    maxAmount: p.maxAmount,
    minTermDays: getTermDays(p, p.minTerm),
    maxTermDays: getTermDays(p, p.maxTerm),
  }
}

function inRange(amountCents: number, termDays: number, lim: Limits): boolean {
  return (
    amountCents >= lim.minAmount &&
    amountCents <= lim.maxAmount &&
    termDays >= lim.minTermDays &&
    termDays <= lim.maxTermDays
  )
}

function rangeLabel(lim: Limits): string {
  const min = formatZAR(lim.minAmount).replace(".00", "")
  const max = formatZAR(lim.maxAmount).replace(".00", "")
  // The compare tab caps the term slider at 365 days, so don't advertise a
  // longer window than the user can actually select (blind-review nit).
  const maxTerm = Math.min(lim.maxTermDays, 365)
  const termLabel = lim.minTermDays === maxTerm ? `${maxTerm} days` : `${lim.minTermDays}–${maxTerm} days`
  return `${min}–${max} over ${termLabel}`
}

// Fees/rates come from the LIVE product (fail-open to static), so this tab agrees
// with the product calculator and updates when the admin edits a rate/fee.
function buildQuote(p: PublicLoanProduct, amountCents: number, termDays: number): LoanCalcResult {
  return calculateLoan({
    principal: amountCents,
    termDays,
    interestRatePm: p.interestRatePm,
    productType: p.productType ?? null,
    interestModel: p.interestModel,
    initiationFeeModel: p.initiationFeeModel,
    initiationFeePct: p.initiationFeePct,
    initiationFeeMax: p.initiationFeeMax,
    monthlyServiceFee: p.monthlyServiceFee,
  })
}

export default function ComparisonTab() {
  const { pricing } = useLivePricing()
  const products = applyLivePricing(pricing)
  const shortTerm = products.find((p) => p.code === "short-term") ?? getPublicLoanProduct("short-term")
  const personalProduct = products.find((p) => p.code === "personal") ?? getPublicLoanProduct("personal")
  const microLimits = limitsFor(shortTerm)
  const personalLimits = limitsFor(personalProduct)
  // The amount slider spans both products (cents).
  const amtMin = Math.min(microLimits.minAmount, personalLimits.minAmount)
  const amtMax = Math.max(microLimits.maxAmount, personalLimits.maxAmount)

  const [amountCents, setAmountCents] = useState(500000)
  const [termDays, setTermDays] = useState(90)

  const safeAmount = clamp(amountCents, amtMin, amtMax)
  const safeTerm = clamp(termDays, 7, 365)

  const microApplicable = inRange(safeAmount, safeTerm, microLimits)
  const personalApplicable = inRange(safeAmount, safeTerm, personalLimits)

  const micro = microApplicable ? buildQuote(shortTerm, safeAmount, safeTerm) : null
  const personal = personalApplicable ? buildQuote(personalProduct, safeAmount, safeTerm) : null

  function handleAmountChange(valueRands: number) {
    setAmountCents(clamp(Math.round(valueRands * 100), amtMin, amtMax))
  }

  function handleTermChange(valueDays: number) {
    setTermDays(clamp(Math.round(valueDays), 7, 365))
  }

  // Total cost = every fee the borrower repays (interest + initiation + service).
  // The initiation fee is always included here and folded into Total Repayable by
  // the calculator's non-degenerate schedule, so the two never contradict.
  const totalCostMicro = micro ? micro.totalInterest + micro.initiationFee + micro.serviceFees : 0
  const totalCostPersonal = personal ? personal.totalInterest + personal.initiationFee + personal.serviceFees : 0
  // Only rank when both products can actually serve this amount + term.
  const bothApplicable = Boolean(micro && personal)
  const diff = bothApplicable ? totalCostMicro - totalCostPersonal : 0
  const betterProduct = diff > 0 ? "Personal loan" : diff < 0 ? "Short-term loan" : "Equal cost"

  return (
    <div className="space-y-6">
      <div className="border border-white/12 bg-[#11141b]/70 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl md:p-7">
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="text-sm font-semibold text-white/78">Amount</label>
            <span className="text-sm font-bold text-[#a5b4fc]">
              {formatZAR(safeAmount)}
            </span>
          </div>
          <div className="relative mb-3">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-white/38">R</span>
            <input
              type="number"
              min={Math.round(amtMin / 100)}
              max={Math.round(amtMax / 100)}
              step={100}
              value={safeAmount / 100}
              onChange={(e) => handleAmountChange(Number(e.target.value))}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full border border-white/12 bg-black/20 py-2.5 pl-8 pr-4 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"
              inputMode="numeric"
            />
          </div>
          <input
            type="range" min={amtMin} max={amtMax}
            step={safeAmount <= 200000 ? 10000 : 50000}
            value={safeAmount}
            onChange={(e) => setAmountCents(clamp(Number(e.target.value), amtMin, amtMax))}
            className="w-full accent-amber-600"
          />
          <div className="flex justify-between text-[11px] text-white/40 mt-1">
            <span>{formatZAR(amtMin).replace(".00", "")}</span><span>{formatZAR(amtMax).replace(".00", "")}</span>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="text-sm font-semibold text-white/78">Term (days)</label>
            <span className="text-sm font-bold text-[#a5b4fc]">{safeTerm} days</span>
          </div>
          <input
            type="range" min={7} max={365} step={1}
            value={safeTerm}
            onChange={(e) => handleTermChange(Number(e.target.value))}
            className="w-full accent-amber-600"
          />
          <input
            type="number"
            min={7}
            max={365}
            step={1}
            value={safeTerm}
            onChange={(e) => handleTermChange(Number(e.target.value))}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-3 w-32 border border-white/12 bg-black/20 px-4 py-2 text-sm text-white focus:border-[#a5b4fc] focus:outline-none"
            inputMode="numeric"
          />
          <div className="flex justify-between text-[11px] text-white/40 mt-1">
            <span>7 days</span><span>365 days</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ComparisonCard
          title="Short-term loan (Daily)"
          result={micro}
          totalCost={totalCostMicro}
          unavailableRange={rangeLabel(microLimits)}
        />
        <ComparisonCard
          title="Personal Loan (Reducing)"
          result={personal}
          totalCost={totalCostPersonal}
          unavailableRange={rangeLabel(personalLimits)}
        />
      </div>

      {bothApplicable ? (
        <div
          className="grid gap-4 border border-[#a5b4fc]/45 bg-[#a5b4fc]/10 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] md:grid-cols-[1fr_auto] md:items-center"
        >
          <div>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.22em] text-[#a5b4fc]">
              Estimated best fit
            </p>
            <p className="text-sm leading-relaxed text-white/62">
              Based on the selected amount and term, this comparison highlights which product appears cheaper before
              affordability and credit checks.
            </p>
          </div>
          <div className="text-left md:text-right">
            <p className="text-2xl font-bold text-white">
              {diff === 0 ? "No cost difference" : `${formatZAR(Math.abs(diff))} cheaper`}
            </p>
            <p className="mt-1 text-sm font-semibold text-[#a5b4fc]">{betterProduct}</p>
          </div>
        </div>
      ) : (
        <div className="border border-[#a5b4fc]/30 bg-[#a5b4fc]/8 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.22em] text-[#a5b4fc]">
            Different products for different needs
          </p>
          <p className="text-sm leading-relaxed text-white/62">
            Short-term loans cover {formatProductRange(shortTerm, "–")} over a fixed 30 days; personal loans cover{" "}
            {formatProductRange(personalProduct, "–")} over 3 to 60 months. They suit different needs, so set an amount
            and term to see each product&apos;s cost — a like-for-like &ldquo;cheaper&rdquo; comparison only applies where
            both could serve the same request.
          </p>
        </div>
      )}

      <p className="text-center text-[11px] leading-relaxed text-white/45">
        Comparison is illustrative. Short-term loans are a fixed 30-day product; personal loans run 3 months or longer.
        Actual eligibility depends on affordability and credit assessment.
      </p>
    </div>
  )
}

function ComparisonCard({
  title,
  result,
  totalCost,
  unavailableRange,
}: {
  title: string
  result: LoanCalcResult | null
  totalCost: number
  unavailableRange: string
}) {
  return (
    <div className="border border-white/12 bg-white/[0.045] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl">
      <p className="mb-4 text-xs font-bold uppercase tracking-[0.18em] text-[#a5b4fc]">
        {title}
      </p>
      {result ? (
        <>
          <Row label="Interest" value={formatZAR(result.totalInterest)} />
          <Row label="Initiation Fee" value={formatZAR(result.initiationFee)} />
          <Row label="Service Fees" value={formatZAR(result.serviceFees)} />
          <Row label="Total Cost" value={formatZAR(totalCost)} bold />
          <Row label="Total Repayable" value={formatZAR(result.totalRepayable)} bold />
        </>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-white/50">
          Not available for this amount or term. This product covers {unavailableRange}.
        </p>
      )}
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={`mt-2 flex items-center justify-between border px-3 py-2 text-sm ${
        bold
          ? "border-[#a5b4fc]/25 bg-[#a5b4fc]/10 font-bold text-[#a5b4fc]"
          : "border-white/8 bg-black/18 text-white/62"
      }`}
    >
      <span className={bold ? "text-xs text-white/70" : "text-xs"}>{label}</span>
      <span className="text-xs">{value}</span>
    </div>
  )
}
