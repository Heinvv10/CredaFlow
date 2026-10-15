"use client"

import { useState, useMemo } from "react"
import { formatZAR } from "@/lib/loan-calculator"
import { computeQualification } from "@/lib/qualify"
import { useT } from "@/lib/i18n/client"

export default function AffordabilityTab() {
  // Seeded with sensible defaults so the tab opens with a live
  // result panel, matching its sibling calculator tabs.
  const [income, setIncome] = useState("15000")
  const [expenses, setExpenses] = useState("6000")
  const [debt, setDebt] = useState("2000")
  const t = useT("websiteCalculators")

  const result = useMemo(() => {
    const incomeCents = Math.round(Number(income) * 100)
    const expensesCents = Math.round(Number(expenses) * 100)
    const debtCents = Math.round(Number(debt) * 100)

    // Single affordability engine: the same computeQualification
    // the portal uses, with the real per-product fee config.
    const q = computeQualification(incomeCents, expensesCents, debtCents)
    // PO funding is an interest-only business product whose "max" ignores the
    // balloon principal repayment; excluding it keeps this consumer max tied to
    // the amortising personal/micro products and avoids overstating capacity.
    const maxLoan = Math.max(q.microLoan.maxAmount, q.personalLoan.maxAmount)

    return { ndi: q.ndi, maxInstalment: q.maxInstalment, maxLoan }
  }, [income, expenses, debt])

  const hasInput = Number(income) > 0

  return (
    <div className="space-y-6">
      <div className="space-y-5 border border-white/12 bg-[#11141b]/70 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl md:p-7">
        <InputField
          label={t("incomeLabel")}
          value={income}
          onChange={setIncome}
        />
        <InputField
          label={t("expensesLabel")}
          value={expenses}
          onChange={setExpenses}
        />
        <InputField
          label={t("debtLabel")}
          value={debt}
          onChange={setDebt}
        />
      </div>

      {hasInput && (
        <div className="border border-white/12 bg-white/[0.045] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.22em] text-[#a5b4fc]">
            {t("affordabilityTitle")}
          </p>
          <Row
            label={t("ndi")}
            value={formatZAR(result.ndi)}
            negative={result.ndi < 0}
          />
          <Row
            label={t("maxInstalment")}
            value={formatZAR(result.maxInstalment)}
            bold
          />
          <Row
            label={t("maxLoan")}
            value={result.maxLoan > 0 ? formatZAR(result.maxLoan) : t("belowMinimum")}
            bold
          />
        </div>
      )}

      <div
        className="border border-[#a5b4fc]/30 bg-[#a5b4fc]/10 p-4 text-sm leading-relaxed text-white/62"
        style={{ borderLeft: "4px solid #4F46E5" }}
      >
        <p className="mb-1 font-semibold text-white">{t("ncaRuleTitle")}</p>
        <p>
          {t("ncaRuleBody")}
        </p>
      </div>
    </div>
  )
}

function InputField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-white/78 mb-1.5">{label}</label>
      <div className="relative">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-white/38">R</span>
        <input
          type="number"
          min={0}
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-white/12 bg-black/20 py-3 pl-8 pr-4 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"
        />
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  bold,
  negative,
}: {
  label: string
  value: string
  bold?: boolean
  negative?: boolean
}) {
  return (
    <div
      className={`mt-2 flex items-center justify-between border px-3 py-2 ${
        bold
          ? "border-[#a5b4fc]/25 bg-[#a5b4fc]/10 font-bold text-[#a5b4fc]"
          : "border-white/8 bg-black/18 text-sm text-white/62"
      }`}
    >
      <span className={bold ? "text-white/70" : ""}>{label}</span>
      <span className={negative ? "text-red-300" : ""}>{value}</span>
    </div>
  )
}
