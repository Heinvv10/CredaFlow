"use client"

import { useState, useMemo } from "react"
import { formatZAR } from "@/lib/utils"
import { computeQualification, type QualificationBounds } from "@/lib/qualify"
import { useT } from "@/lib/i18n/client"

interface ExploreClient {
  monthlyIncome: number   // cents
  monthlyExpenses: number // cents
  existingDebt: number    // cents
}

export function ndiColor(ndi: number): string {
  if (ndi > 0) return "#22c55e"
  if (ndi >= -50000) return "#f59e0b"
  return "#ef4444"
}

// Rands with cents, so the starting scenario is the profile to the cent and
// shows the same NDI and max instalment as the panel above (whole rands did not).
const toRands = (cents: number) => cents / 100
const toCents = (rands: number) => Math.round(rands * 100)

export function ExploreCalculator({ client, bounds }: { client: ExploreClient | null; bounds: QualificationBounds }) {
  const [income, setIncome] = useState(toRands(client?.monthlyIncome ?? 0))
  const [expenses, setExpenses] = useState(toRands(client?.monthlyExpenses ?? 0))
  const [debt, setDebt] = useState(toRands(client?.existingDebt ?? 0))

  const qual = useMemo(
    () => income > 0 ? computeQualification(toCents(income), toCents(expenses), toCents(debt), bounds) : null,
    [income, expenses, debt, bounds]
  )

  const inputClass = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
  const t = useT("portalApply")

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
      <h2 className="text-base font-bold text-gray-900 mb-1">{t("exploreTitle")}</h2>
      <p className="text-[12px] text-gray-500 mb-1">{t("exploreNotSaved")}</p>
      <p className="text-[11px] text-gray-400 mb-5">{t("exploreEstimates")}</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {([
          { label: t("incomeR"), value: income, setter: setIncome },
          { label: t("expensesR"), value: expenses, setter: setExpenses },
          { label: t("debtR"), value: debt, setter: setDebt },
        ] as const).map(({ label, value, setter }) => (
          <div key={label}>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={value}
              onChange={(e) => setter(Math.max(0, Number(e.target.value)))}
              className={inputClass}
            />
          </div>
        ))}
      </div>

      {qual && (
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">{t("ndi")}</p>
            <p className="font-bold" style={{ color: ndiColor(qual.ndi) }}>{formatZAR(qual.ndi)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">{t("microLoan")}</p>
            <p className="font-semibold text-gray-800">{qual.microLoan.maxAmount > 0 ? formatZAR(qual.microLoan.maxAmount) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">{t("personalLoan")}</p>
            <p className="font-semibold text-gray-800">{qual.personalLoan.maxAmount > 0 ? formatZAR(qual.personalLoan.maxAmount) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">{t("maxInstalment")}</p>
            <p className="font-semibold" style={{ color: "#4F46E5" }}>{formatZAR(qual.maxInstalment)}</p>
          </div>
        </div>
      )}
    </div>
  )
}
