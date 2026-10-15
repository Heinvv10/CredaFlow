"use client"

import { useT } from "@/lib/i18n/client"

interface StepOneData {
  employmentStatus: string
  monthlyIncome: string
  monthlyExpenses: string
}

interface StepOneProps {
  data: StepOneData
  onChange: (data: StepOneData) => void
  onNext: () => void
}

const EMPLOYMENT_OPTIONS = [
  { value: "employed", label: "employed" },
  { value: "self-employed", label: "selfEmployed" },
  { value: "pensioner", label: "pensioner" },
  { value: "unemployed", label: "unemployed" },
] as const

export default function QualifyStepOne({ data, onChange, onNext }: StepOneProps) {
  const t = useT("websiteQualify")
  const canProceed =
    data.employmentStatus !== "" &&
    Number(data.monthlyIncome) > 0 &&
    Number(data.monthlyExpenses) >= 0

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-semibold text-white/78">
          {t("employmentStatus")}
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EMPLOYMENT_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => onChange({ ...data, employmentStatus: opt.value })}
              className={`border px-4 py-2.5 text-left text-sm font-semibold transition-colors ${
                data.employmentStatus === opt.value
                  ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
                  : "border-white/12 bg-white/[0.04] text-white/62 hover:border-white/22 hover:text-white"
              }`}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-semibold text-white/78">
          {t("incomeLabel")}
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-white/38">R</span>
          <input
            type="number"
            min={0}
            placeholder="0.00"
            value={data.monthlyIncome}
            onChange={(e) => onChange({ ...data, monthlyIncome: e.target.value })}
            className="w-full border border-white/12 bg-black/20 py-2.5 pl-8 pr-4 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-semibold text-white/78">
          {t("expensesLabel")}
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-white/38">R</span>
          <input
            type="number"
            min={0}
            placeholder="0.00"
            value={data.monthlyExpenses}
            onChange={(e) => onChange({ ...data, monthlyExpenses: e.target.value })}
            className="w-full border border-white/12 bg-black/20 py-2.5 pl-8 pr-4 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"
          />
        </div>
      </div>

      <button
        onClick={onNext}
        disabled={!canProceed}
        className="w-full bg-[#a5b4fc] py-2.5 text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30"
      >
        {t("continue")}
      </button>
    </div>
  )
}
