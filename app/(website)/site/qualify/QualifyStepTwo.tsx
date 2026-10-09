"use client"

import { useEffect } from "react"
import {
  formatInterestLabel,
  getPublicLoanProduct,
  microMaxRands,
  productForAmount,
  qualifyAmountBoundsRands,
  qualifyTerm,
  qualifyTermWindow,
  type PublicLoanProduct,
} from "@/lib/public-loan-products"

interface StepTwoData {
  amount: number
  purpose: string
  term: number
}

interface StepTwoProps {
  data: StepTwoData
  onChange: (data: StepTwoData) => void
  onNext: () => void
  onBack: () => void
  // Live-overlaid product catalogue (applyLivePricing(pricing)) from the page, so
  // the slider bounds + micro/personal boundary track the admin's ranges.
  products: PublicLoanProduct[]
}

const PURPOSE_OPTIONS = [
  { value: "emergency", label: "Emergency expenses" },
  { value: "education", label: "Education" },
  { value: "medical", label: "Medical" },
  { value: "household", label: "Household" },
  { value: "business", label: "Business" },
  { value: "other", label: "Other" },
]

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

export default function QualifyStepTwo({ data, onChange, onNext, onBack, products }: StepTwoProps) {
  // Amount bounds (rands) + micro/personal classification, both derived from the
  // LIVE products (fail-open to static). isMicro uses the SHARED productForAmount
  // tiering rule, so the wizard and the apply form can never disagree (Phase 2).
  const amountBounds = qualifyAmountBoundsRands(products)
  const safeAmount = clamp(Math.round(data.amount), amountBounds.min, amountBounds.max)
  const isMicro = productForAmount(safeAmount, products) === "MICRO"
  const { min: termMin, max: termMax, unit: termLabel } = qualifyTermWindow(isMicro)

  // The two wizard tiers, live-overlaid (fail-open to static), for the indicator.
  const microProduct = products.find((p) => p.code === "short-term") ?? getPublicLoanProduct("short-term")
  const personalProduct = products.find((p) => p.code === "personal") ?? getPublicLoanProduct("personal")
  const boundaryRands = microMaxRands(products)

  // `data.term` is stored CANONICALLY in DAYS, so it is never unit-ambiguous — the
  // micro↔personal boundary only changes how it is DISPLAYED, not what it means. The
  // shared qualifyTerm() helper converts days→the tier's display value (clamped) and
  // back to canonical days, so a boundary flip (drag, live-range change, OR a
  // restored draft classified differently on first render) needs no reconciliation.
  const { display: displayTerm, days: safeTermDays } = qualifyTerm(data.term, isMicro)
  const canProceed =
    safeAmount >= amountBounds.min && data.purpose !== "" && displayTerm >= termMin

  // Commit the clamped amount + canonical-days term so neither diverges from what's
  // shown. Idempotent: once committed, safeAmount === data.amount and safeTermDays
  // === data.term (display→days round-trips exactly for 30-multiples), so it stops.
  useEffect(() => {
    if (data.amount !== safeAmount || data.term !== safeTermDays) {
      onChange({ ...data, amount: safeAmount, term: safeTermDays })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeAmount, safeTermDays, data.amount, data.term])

  function handleAmountChange(val: number) {
    // Set the amount only; the effect above re-derives the displayed term for the
    // new classification (canonical days need no explicit reconciliation).
    onChange({ ...data, amount: clamp(Math.round(val), amountBounds.min, amountBounds.max) })
  }

  function handleTermChange(displayVal: number) {
    const d = clamp(Math.round(displayVal), termMin, termMax)
    onChange({ ...data, term: isMicro ? d : d * 30 })
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <label className="text-sm font-semibold text-white/78">Loan Amount</label>
          <span className="text-sm font-bold text-[#a5b4fc]">
            R {safeAmount.toLocaleString("en-ZA")}
          </span>
        </div>
        <div className="relative mb-3">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-white/38">R</span>
          <input
            type="number"
            min={amountBounds.min}
            max={amountBounds.max}
            step={100}
            value={safeAmount}
            onChange={(e) => handleAmountChange(Number(e.target.value))}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full border border-white/12 bg-black/20 py-2.5 pl-8 pr-4 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"
            inputMode="numeric"
          />
        </div>
        <input
          type="range"
          min={amountBounds.min}
          max={amountBounds.max}
          step={isMicro ? 100 : 500}
          value={safeAmount}
          onChange={(e) => handleAmountChange(Number(e.target.value))}
          className="w-full accent-amber-600"
        />
        <div className="mt-1 flex justify-between text-[11px] text-white/40">
          <span>R {amountBounds.min.toLocaleString("en-ZA")}</span>
          <span>R {amountBounds.max.toLocaleString("en-ZA")}</span>
        </div>
        {/* Tier indicator (display-only): the amount picks the product via the shared
            productForAmount rule; this makes that auto-selection visible — including
            the term-unit flip (days↔months) — instead of a easy-to-miss text line.
            Labels, boundary and rates all come from the live-overlaid catalogue. */}
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-live="polite">
          {[
            {
              product: microProduct,
              active: isMicro,
              range: `Up to R ${boundaryRands.toLocaleString("en-ZA")}`,
              termWindow: qualifyTermWindow(true),
            },
            {
              product: personalProduct,
              active: !isMicro,
              range: `Over R ${boundaryRands.toLocaleString("en-ZA")}`,
              termWindow: qualifyTermWindow(false),
            },
          ].map(({ product, active, range, termWindow }) => (
            <div
              key={product.code}
              className={`border px-3 py-2 transition-colors ${
                active ? "border-[#a5b4fc]/60 bg-[#a5b4fc]/10" : "border-white/10 bg-white/[0.03]"
              }`}
            >
              <p className={`text-xs font-bold ${active ? "text-[#a5b4fc]" : "text-white/45"}`}>
                {product.label}
                {active && <span className="sr-only"> — selected for this amount</span>}
              </p>
              <p className={`mt-0.5 text-[11px] ${active ? "text-white/70" : "text-white/38"}`}>
                {range} · {formatInterestLabel(product)} · {termWindow.min}–{termWindow.max} {termWindow.unit}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-semibold text-white/78">Purpose</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PURPOSE_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => onChange({ ...data, purpose: opt.value })}
              className={`border px-4 py-2.5 text-left text-sm font-semibold transition-colors ${
                data.purpose === opt.value
                  ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
                  : "border-white/12 bg-white/[0.04] text-white/62 hover:border-white/22 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-1.5">
          <label className="text-sm font-semibold text-white/78">
            Term ({termLabel})
          </label>
          <span className="text-sm font-bold text-[#a5b4fc]">
            {displayTerm} {termLabel}
          </span>
        </div>
        <input
          type="range"
          min={termMin}
          max={termMax}
          step={1}
          value={displayTerm}
          onChange={(e) => handleTermChange(Number(e.target.value))}
          className="w-full accent-amber-600"
        />
        <input
          type="number"
          min={termMin}
          max={termMax}
          step={1}
          value={displayTerm}
          onChange={(e) => handleTermChange(Number(e.target.value))}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-3 w-32 border border-white/12 bg-black/20 px-4 py-2 text-sm text-white focus:border-[#a5b4fc] focus:outline-none"
          inputMode="numeric"
        />
        <div className="mt-1 flex justify-between text-[11px] text-white/40">
          <span>{termMin} {termLabel}</span>
          <span>{termMax} {termLabel}</span>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 border border-white/18 py-2.5 text-sm font-bold text-white/72 transition-colors hover:bg-white/[0.05] hover:text-white"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="flex-1 bg-[#a5b4fc] py-2.5 text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30"
        >
          Check Qualification
        </button>
      </div>
    </div>
  )
}
