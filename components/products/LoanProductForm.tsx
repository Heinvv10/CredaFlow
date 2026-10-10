"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { annualisedInterestRate } from "@/lib/loan/annualised-rate"
import { ncaInitiationFeeCap } from "@/lib/loan/nca-fee-cap"

type InterestModel = "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
type ProductType = "MICRO" | "PERSONAL" | "PO_FUNDING"

type LoanProduct = {
  id?: string
  code: string
  name: string
  productType: ProductType
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
  interestRatePm: number
  interestModel: InterestModel
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
  active: boolean
}

const EMPTY: LoanProduct = {
  code: "", name: "", productType: "PERSONAL",
  minAmount: 1000, maxAmount: 50000,
  minTermDays: 30, maxTermDays: 365,
  interestRatePm: 3, interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "FLAT_PCT",
  initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, active: true,
}

// Advisory NCA per-month interest caps for the admin form (non-blocking guidance).
// NOTE: the real NCA cap is set by CREDIT TYPE, not interest model — MICRO is
// short-term credit (5%/month ceiling), so it's 5% across all models here (a FLAT
// or reducing micro at 5% must not false-flag). PERSONAL (unsecured) stays a
// conservative 3%/month proxy for its repo-linked annual cap. These figures are
// guidance only; confirm the current statutory limits with legal.
const NCA_CAPS: Record<InterestModel, Record<ProductType, { cap: number; label: string; unit: string }>> = {
  FLAT: {
    MICRO: { cap: 5, label: "NCA cap: 5% p/m", unit: "% per month" },
    PERSONAL: { cap: 3, label: "NCA cap: 3% p/m", unit: "% per month" },
    PO_FUNDING: { cap: 3, label: "NCA cap: 3% p/m", unit: "% per month" },
  },
  REDUCING_BALANCE: {
    MICRO: { cap: 5, label: "NCA cap: 5% p/m", unit: "% per month" },
    PERSONAL: { cap: 3, label: "NCA cap: 3% p/m", unit: "% per month" },
    PO_FUNDING: { cap: 3, label: "NCA cap: 3% p/m", unit: "% per month" },
  },
  DAILY_ACCRUAL: {
    MICRO: { cap: 5, label: "NCA cap: 5% p/m", unit: "% per month" },
    PERSONAL: { cap: 5, label: "NCA cap: 5% p/m", unit: "% per month" },
    PO_FUNDING: { cap: 5, label: "NCA cap: 5% p/m", unit: "% per month" },
  },
}

const MODEL_DESCRIPTIONS: Record<InterestModel, string> = {
  FLAT: "Interest calculated on original principal for full term. Simple and predictable. Common for micro/short-term loans.",
  REDUCING_BALANCE: "Interest calculated on outstanding balance each month. Client pays less interest as they repay. Standard for personal loans.",
  DAILY_ACCRUAL: "Interest accrues daily on outstanding balance. Best for variable-term or PO funding where repayment date is uncertain.",
}

// ── Calculation engines ─────────────────────────────────────────────────────

// All preview functions take rates as entered by user (e.g. 3 = 3%, 0.17 = 0.17%)
// and convert to decimal internally

interface CalcResult {
  totalInterest: number
  totalRepayable: number
  termMonths: number
  billedMonths: number       // whole months for fee billing (min 1)
  isSingleRepayment: boolean // flat/daily = lump sum at end, not monthly
  singleRepayment: number    // amount due at end (flat/daily)
  monthlyPayment: number     // only meaningful for REDUCING_BALANCE
}

function calcFlat(principal: number, ratePm: number, termDays: number): CalcResult {
  const termMonths = termDays / 30
  const r = ratePm / 100
  const totalInterest = principal * r * termMonths
  const totalRepayable = principal + totalInterest
  return {
    totalInterest, totalRepayable, termMonths,
    billedMonths: Math.max(1, Math.ceil(termMonths)),
    isSingleRepayment: true,
    singleRepayment: totalRepayable,
    monthlyPayment: 0,
  }
}

function calcReducing(principal: number, ratePm: number, termDays: number): CalcResult {
  const n = Math.max(1, Math.round(termDays / 30))
  const r = ratePm / 100
  if (r === 0) {
    const mp = principal / n
    return { totalInterest: 0, totalRepayable: principal, termMonths: n, billedMonths: n, isSingleRepayment: false, singleRepayment: 0, monthlyPayment: mp }
  }
  const monthlyPayment = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  const totalRepayable = monthlyPayment * n
  const totalInterest = totalRepayable - principal
  return { totalInterest, totalRepayable, termMonths: n, billedMonths: n, isSingleRepayment: false, singleRepayment: 0, monthlyPayment }
}

function calcDaily(principal: number, ratePm: number, termDays: number): CalcResult {
  // interestRatePm is a MONTHLY rate; daily accrual spreads it over the term
  // (rate/30 per day), matching lib/loan-calculator.ts.
  const r = ratePm / 100
  const totalInterest = principal * (r / 30) * termDays
  const totalRepayable = principal + totalInterest
  const termMonths = termDays / 30
  return {
    totalInterest, totalRepayable, termMonths,
    billedMonths: Math.max(1, Math.ceil(termMonths)),
    isSingleRepayment: true,
    singleRepayment: totalRepayable,
    monthlyPayment: 0,
  }
}

function formatR(n: number) {
  return "R " + n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Component ────────────────────────────────────────────────────────────────

export function LoanProductForm({ initial }: { initial?: LoanProduct }) {
  const router = useRouter()
  const [form, setForm] = useState<LoanProduct>(initial ?? EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  // Preview state
  const [previewAmount, setPreviewAmount] = useState(
    initial ? Math.round((initial.minAmount + initial.maxAmount) / 2) : 10000
  )
  const [previewTerm, setPreviewTerm] = useState(initial?.minTermDays ?? 30)

  const set = <K extends keyof LoanProduct>(k: K, v: LoanProduct[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const ncaCap = NCA_CAPS[form.interestModel][form.productType]
  const isOverCap = form.interestRatePm > ncaCap.cap

  // NCA fee guardrails — guidance only (non-blocking, like the interest badge).
  // Thresholds mirror the field hints below and the values calculateLoan bills.
  const serviceFeeOverCap = form.monthlyServiceFee > 69 // R60 + VAT = R69/month (NCA max)
  const initiationPctOverCap = form.initiationFeePct > 15 // NCA max 15% of principal

  // interestRatePm is a monthly rate for every model, including DAILY_ACCRUAL
  // (which accrues that monthly rate daily — see lib/loan-calculator.ts,.
  const displayRateLabel = "% per month"

  // Live repayment preview
  const preview = useMemo(() => {
    const p = previewAmount
    const r = form.interestRatePm
    const t = previewTerm
    if (!p || !r || !t) return null
    const base = form.interestModel === "FLAT" ? calcFlat(p, r, t)
      : form.interestModel === "REDUCING_BALANCE" ? calcReducing(p, r, t)
      : calcDaily(p, r, t)
    // This form counts in RANDS; nca-fee-cap counts in CENTS. Convert at the
    // call. NCA_REG42 prices ON the schedule, so the percentage is not used.
    const statutoryCeiling = ncaInitiationFeeCap(Math.round(p * 100)) / 100
    const priced = form.initiationFeeModel === "NCA_REG42"
      ? statutoryCeiling
      : p * (form.initiationFeePct / 100)
    const commercial = form.initiationFeeMax > 0 ? Math.min(priced, form.initiationFeeMax) : priced
    // The ceiling applies to consumer credit only — PO funding is a different regime.
    const cappedInitFee = form.productType === "PO_FUNDING"
      ? commercial
      : Math.min(commercial, statutoryCeiling)
    // Service fees: charge per whole month (min 1), not fractional
    const totalServiceFees = form.monthlyServiceFee * base.billedMonths
    return {
      ...base,
      initiationFee: cappedInitFee,
      totalServiceFees,
      totalCost: base.totalRepayable + cappedInitFee + totalServiceFees,
    }
  }, [previewAmount, previewTerm, form.interestRatePm, form.interestModel, form.initiationFeeModel, form.initiationFeePct, form.initiationFeeMax, form.monthlyServiceFee, form.productType])

  // Annualised rate for comparison — same derivation the PASQ, credit agreement
  // and statement use, so the figure staff see while configuring a product is
  // the figure the consumer is given. This previously computed
  // interestRatePm * 12 and LABELLED it "effective": a third convention that
  // disagreed with both documents (36.0% here vs 42.6% printed on PERSONAL).
  const ear = useMemo(
    () => annualisedInterestRate({ interestRatePm: form.interestRatePm / 100, interestModel: form.interestModel }),
    [form.interestRatePm, form.interestModel],
  )

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError("")
    try {
      const url = form.id ? `/api/products/loan/${form.id}` : "/api/products/loan"
      const method = form.id ? "PUT" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error(await res.text())
      router.push("/settings/products/loan")
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const inp = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]"
  const lbl = "block text-sm font-medium text-[#1b1d24] mb-1"

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/settings/products/loan" className="text-sm text-gray-500 hover:text-gray-700">← Loan Products</Link>
        <h1 className="text-xl font-bold text-[#1b1d24]">{form.id ? "Edit" : "New"} Loan Product</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      <form onSubmit={save} className="space-y-5">
        {/* ── Identity ── */}
        <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Product Identity</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Product Code</label>
              <input className={inp} value={form.code} onChange={e => set("code", e.target.value)} required placeholder="e.g. MICRO-30" />
            </div>
            <div>
              <label className={lbl}>Product Name</label>
              <input className={inp} value={form.name} onChange={e => set("name", e.target.value)} required placeholder="e.g. 30-Day Micro Loan" />
            </div>
          </div>
          <div>
            <label className={lbl}>Product Type</label>
            <select value={form.productType} onChange={e => set("productType", e.target.value as ProductType)} className={inp}>
              <option value="MICRO">Micro Loan</option>
              <option value="PERSONAL">Personal Loan</option>
              <option value="PO_FUNDING">PO Funding</option>
            </select>
          </div>
        </div>

        {/* ── Loan Parameters ── */}
        <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Loan Parameters</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Min Amount (R)</label>
              <input type="text" inputMode="decimal" className={inp} value={form.minAmount}
                onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) { set("minAmount", n); setPreviewAmount(n) } }} />
            </div>
            <div>
              <label className={lbl}>Max Amount (R)</label>
              <input type="text" inputMode="decimal" className={inp} value={form.maxAmount}
                onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) set("maxAmount", n) }} />
            </div>
            <div>
              <label className={lbl}>Min Term (days)</label>
              <input type="text" inputMode="numeric" className={inp} value={form.minTermDays}
                onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) { set("minTermDays", n); setPreviewTerm(n) } }} />
            </div>
            <div>
              <label className={lbl}>Max Term (days)</label>
              <input type="text" inputMode="numeric" className={inp} value={form.maxTermDays}
                onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) set("maxTermDays", n) }} />
            </div>
          </div>
        </div>

        {/* ── Interest ── */}
        <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Interest Model & Rate</p>

          {/* Model selector — cards */}
          <div className="grid grid-cols-3 gap-3">
            {(["FLAT", "REDUCING_BALANCE", "DAILY_ACCRUAL"] as InterestModel[]).map(m => (
              <label key={m} className={`cursor-pointer p-3 rounded-xl border-2 transition-colors ${form.interestModel === m ? "border-[#4F46E5] bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}>
                <input type="radio" name="interestModel" value={m} checked={form.interestModel === m} onChange={() => set("interestModel", m)} className="sr-only" />
                <p className="font-semibold text-xs text-[#1b1d24]">
                  {m === "FLAT" ? "Flat Rate" : m === "REDUCING_BALANCE" ? "Reducing Balance" : "Daily Accrual"}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">
                  {m === "FLAT" ? "On original principal" : m === "REDUCING_BALANCE" ? "On outstanding balance" : "Per day on balance"}
                </p>
              </label>
            ))}
          </div>

          {/* Model description */}
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            {MODEL_DESCRIPTIONS[form.interestModel]}
          </p>

          {/* Rate input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={lbl}>Interest Rate ({displayRateLabel})</label>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isOverCap ? "bg-red-100 text-red-600" : "bg-green-100 text-green-600"}`}>
                {isOverCap ? `⚠️ Exceeds NCA cap` : `✓ Within NCA cap`} — {ncaCap.label}
              </span>
            </div>

            <div className="flex gap-3 items-start">
              <div className="flex-1">
                <input
                  type="text"
                  inputMode="decimal"
                  className={`${inp} text-lg font-bold ${isOverCap ? "border-red-300 focus:border-red-400 focus:ring-red-200" : ""}`}
                  value={form.interestRatePm}
                  onChange={e => {
                    const raw = e.target.value.replace(",", ".")
                    const n = parseFloat(raw)
                    if (!isNaN(n)) set("interestRatePm", n)
                    else if (raw === "" || raw === ".") set("interestRatePm", 0)
                  }}
                />
                <div className="flex gap-4 mt-2">
                  <p className="text-xs text-gray-500">
                    Annual rate: <b>{ear.percent.toFixed(1)}%</b> {ear.basisLabel}
                  </p>
                  {form.interestModel === "REDUCING_BALANCE" && (
                    <p className="text-xs text-gray-500">
                      Approx daily: <b>{(form.interestRatePm / 30).toFixed(4)}%</b>
                    </p>
                  )}
                  {form.interestModel === "FLAT" && (
                    <p className="text-xs text-gray-500">
                      Approx daily: <b>{(form.interestRatePm / 30).toFixed(4)}%</b>
                    </p>
                  )}
                  {form.interestModel === "DAILY_ACCRUAL" && (
                    <p className="text-xs text-gray-500">
                      Approx daily: <b>{(form.interestRatePm / 30).toFixed(4)}%</b>
                    </p>
                  )}
                </div>
              </div>

              {/* Quick rate buttons */}
              <div>
                <p className="text-xs text-gray-400 mb-1">Common rates</p>
                <div className="flex flex-wrap gap-1">
                  {[1, 2, 2.5, 3, 5].map(r => (
                    <button key={r} type="button" onClick={() => set("interestRatePm", r)}
                      className={`px-2 py-0.5 text-xs rounded border ${form.interestRatePm === r ? "bg-[#4F46E5] text-white border-[#4F46E5]" : "border-gray-200 hover:bg-gray-50"}`}>
                      {r}%
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Live preview ── */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Live Repayment Preview</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Example Loan Amount (R)</label>
                <input type="text" inputMode="decimal" className={`${inp} text-sm`} value={previewAmount}
                  onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) setPreviewAmount(n) }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Term (days)</label>
                <input type="text" inputMode="numeric" className={`${inp} text-sm`} value={previewTerm}
                  onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) setPreviewTerm(n) }} />
              </div>
            </div>

            {preview && (
              <div className="bg-amber-50 border border-[#4F46E5]/20 rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    {preview.isSingleRepayment ? (
                      <>
                        <p className="text-xs text-gray-500 mb-1">Amount Due at Maturity</p>
                        <p className="text-lg font-bold text-[#1b1d24]">{formatR(preview.singleRepayment)}</p>
                        <p className="text-[11px] text-gray-400">single repayment</p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-gray-500 mb-1">Monthly Instalment</p>
                        <p className="text-lg font-bold text-[#1b1d24]">{formatR(preview.monthlyPayment)}</p>
                        <p className="text-[11px] text-gray-400">× {preview.billedMonths} months</p>
                      </>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Total Interest</p>
                    <p className="text-lg font-bold text-[#4F46E5]">{formatR(preview.totalInterest)}</p>
                    <p className="text-[11px] text-gray-400">{((preview.totalInterest / previewAmount) * 100).toFixed(2)}% of principal</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Total Repayable</p>
                    <p className="text-lg font-bold text-[#1b1d24]">{formatR(preview.totalRepayable)}</p>
                    <p className="text-[11px] text-gray-400">principal + interest</p>
                  </div>
                </div>
                {(preview.initiationFee > 0 || preview.totalServiceFees > 0) && (
                  <div className="border-t border-[#4F46E5]/20 pt-3 grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Initiation Fee</p>
                      <p className="text-sm font-semibold text-gray-700">{formatR(preview.initiationFee)}</p>
                      <p className="text-[11px] text-gray-400">{form.initiationFeeModel === "NCA_REG42" ? "per NCA Reg 42 (the % above is not used)" : `${form.initiationFeePct}% of principal`}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Service Fees</p>
                      <p className="text-sm font-semibold text-gray-700">{formatR(preview.totalServiceFees)}</p>
                      <p className="text-[11px] text-gray-400">R{form.monthlyServiceFee}/mo × {preview.billedMonths} month{preview.billedMonths !== 1 ? "s" : ""}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Total Cost to Client</p>
                      <p className="text-sm font-bold text-red-600">{formatR(preview.totalCost)}</p>
                      <p className="text-[11px] text-gray-400">all-in</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Fees ── */}
        <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Fees (NCA Compliant)</p>
            <a href="https://www.ncr.org.za" target="_blank" rel="noreferrer" className="text-xs text-[#4F46E5] hover:underline">NCA fee limits →</a>
          </div>
          <div>
            <label className={lbl}>Initiation fee pricing</label>
            <select className={inp} value={form.initiationFeeModel}
              onChange={e => set("initiationFeeModel", e.target.value as "FLAT_PCT" | "NCA_REG42")}>
              <option value="FLAT_PCT">Flat percentage of principal</option>
              <option value="NCA_REG42">NCA Reg 42 schedule (recommended for consumer credit)</option>
            </select>
            <p className="mt-1 text-[11px] text-gray-400">
              {form.initiationFeeModel === "NCA_REG42"
                ? "Priced on the statutory schedule, so the fee published to customers is the fee charged. The percentage below is ignored; the cap still applies if you want to charge less than the maximum."
                : "Priced on the percentage below. The statutory ceiling is still applied on top, so a percentage above it will not be charged — and the published percentage will not match the invoice."}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={lbl}>Initiation Fee (%)</label>
              <input type="text" inputMode="decimal"
                className={`${inp} ${initiationPctOverCap ? "border-red-300 focus:border-red-400 focus:ring-red-200" : ""}`}
                value={form.initiationFeePct}
                onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) set("initiationFeePct", n) }} />
              <p className={`text-[11px] mt-1 ${initiationPctOverCap ? "font-semibold text-red-600" : "text-gray-400"}`}>
                {initiationPctOverCap ? "⚠️ Above NCA max — 15% of principal" : "NCA max: 15% + VAT"}
              </p>
            </div>
            <div>
              <label className={lbl}>Initiation Fee Max (R)</label>
              <input type="text" inputMode="decimal" className={inp} value={form.initiationFeeMax}
                onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) set("initiationFeeMax", n) }} />
              <p className="text-[11px] text-gray-400 mt-1">NCA abs max: R1,207.50</p>
            </div>
            <div>
              <label className={lbl}>Monthly Service Fee (R)</label>
              <input type="text" inputMode="decimal"
                className={`${inp} ${serviceFeeOverCap ? "border-red-300 focus:border-red-400 focus:ring-red-200" : ""}`}
                value={form.monthlyServiceFee}
                onChange={e => { const n = parseFloat(e.target.value.replace(",", ".")); if (!isNaN(n)) set("monthlyServiceFee", n) }} />
              <p className={`text-[11px] mt-1 ${serviceFeeOverCap ? "font-semibold text-red-600" : "text-gray-400"}`}>
                {serviceFeeOverCap ? "⚠️ Above NCA max — R60 + VAT = R69/month" : "NCA max: R69/month (R60 + VAT)"}
              </p>
            </div>
          </div>
        </div>

        {/* ── Status ── */}
        <div className="bg-white rounded-2xl shadow-sm p-4 flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)}
              className="h-4 w-4 rounded accent-[#4F46E5]" />
            <span className="text-sm font-medium text-[#1b1d24]">Active — available for new applications</span>
          </label>
        </div>

        {/* ── Actions ── */}
        <div className="flex justify-end gap-3">
          <Link href="/settings/products/loan"
            className="px-4 py-2 border border-gray-200 text-sm rounded-lg hover:bg-gray-50">Cancel</Link>
          <button type="submit" disabled={saving}
            className="px-6 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50">
            {saving ? "Saving…" : form.id ? "Update Product" : "Create Product"}
          </button>
        </div>
      </form>
    </div>
  )
}
