"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { Zap, Star, Briefcase, AlertTriangle } from "lucide-react"
import { formatZAR } from "@/lib/utils"
import { computeQualification, type QualificationResult } from "@/lib/qualify"

interface ClientData {
  firstName: string
  monthlyIncome: number   // cents
  monthlyExpenses: number // cents
  existingDebt: number    // cents
}

type ProductKey = "micro" | "personal" | "po"

interface Props {
  client: ClientData | null
  qualification: QualificationResult | null
  // Live amount-range strings ("R500 – R10,000") per product, resolved server-side
  // from the LoanProduct rows (fail-open to static) so the copy tracks the admin.
  productRanges: Record<ProductKey, string>
}

function ndiColor(ndi: number): string {
  if (ndi > 0) return "#22c55e"
  if (ndi >= -50000) return "#f59e0b"
  return "#ef4444"
}

function AffordabilityCard({ client, qual }: { client: ClientData; qual: QualificationResult | null }) {
  const incomplete = client.monthlyIncome === 0

  return (
    <div className="mb-6 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-6 text-[var(--cf-text)]">
      <h2 className="text-lg font-bold mb-4">My Affordability</h2>

      {incomplete && (
        <div
          className="flex items-start gap-3 rounded-lg p-4 mb-4 text-sm"
          style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b" }}
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
          <span className="text-[var(--cf-text-secondary)]">
            Complete your profile to see personalised results.{" "}
            <Link href="/portal/profile" className="underline" style={{ color: "#4338CA" }}>
              Update profile →
            </Link>
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        {[
          { label: "Monthly Income", value: formatZAR(client.monthlyIncome) },
          { label: "Monthly Expenses", value: formatZAR(client.monthlyExpenses) },
          { label: "Existing Debt", value: formatZAR(client.existingDebt) },
        ].map(({ label, value }) => (
          <div key={label}>
            <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">{label}</p>
            <p className="font-semibold text-[var(--cf-text)]">{value}</p>
          </div>
        ))}
        <div>
          <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">Net Disposable Income</p>
          <p
            className="font-bold text-base"
            style={{ color: qual ? ndiColor(qual.ndi) : "#6b7280" }}
          >
            {qual ? formatZAR(qual.ndi) : "—"}
          </p>
        </div>
        <div>
          <p className="text-gray-400 text-[11px] uppercase tracking-wide mb-0.5">Max Instalment (70% NDI)</p>
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
    title: "30-Day Micro Loan",
    subtitle: "Quick cash for short-term needs",
    paymentLabel: "Total repayable",
  },
  {
    key: "personal" as const,
    icon: Star,
    title: "Personal Loan",
    subtitle: "Flexible financing for life goals",
    paymentLabel: "Monthly instalment",
  },
  {
    key: "po" as const,
    icon: Briefcase,
    title: "PO Funding",
    subtitle: "Unlock confirmed purchase orders",
    paymentLabel: "Monthly interest",
  },
]

function ProductCards({ qual, productRanges }: { qual: QualificationResult | null; productRanges: Record<ProductKey, string> }) {
  const amounts = {
    micro: qual?.microLoan.maxAmount ?? 0,
    personal: qual?.personalLoan.maxAmount ?? 0,
    po: qual?.poFunding.maxAmount ?? 0,
  }
  const payments = {
    micro: qual?.microLoan.totalRepayable ?? 0,
    personal: qual?.personalLoan.monthlyInstalment ?? 0,
    po: qual?.poFunding.monthlyInterest ?? 0,
  }

  return (
    <div className="mb-6">
      <h2 className="text-lg font-bold text-gray-900 mb-4">What You Qualify For</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PRODUCTS.map(({ key, icon: Icon, title, subtitle, paymentLabel }) => {
          const amount = amounts[key]
          const payment = payments[key]
          const featured = key === "personal"

          return (
            <div
              key={key}
              className="bg-white rounded-xl shadow-sm overflow-hidden flex flex-col"
              style={{ border: `${featured ? 2 : 1}px solid ${featured ? "#4F46E5" : "#e5e7eb"}` }}
            >
              {featured && (
                <div className="py-1.5 text-center text-[11px] font-bold uppercase tracking-wide text-white" style={{ backgroundColor: "#4F46E5" }}>
                  Best Match
                </div>
              )}
              <div className="p-5 flex flex-col flex-1">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center mb-3 border border-[var(--cf-border-subtle)]"
                    style={{ backgroundColor: featured ? "#4F46E5" : "var(--cf-bg-raised)" }}
                  >
                  <Icon className="h-4 w-4" style={{ color: featured ? "#fff" : "#4F46E5" }} />
                </div>
                <h3 className="text-sm font-bold text-gray-900 mb-0.5">{title}</h3>
                <p className="text-[11px] text-gray-500 mb-3">{subtitle}</p>

                {qual ? (
                  amount > 0 ? (
                    <>
                      <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-0.5">You qualify for up to</p>
                      <p className="text-xl font-bold mb-1" style={{ color: "#4F46E5" }}>{formatZAR(amount)}</p>
                      <p className="text-[12px] text-gray-500 mb-4">
                        {paymentLabel}: <span className="font-semibold text-gray-700">{formatZAR(payment)}</span>
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-gray-400 mb-4 flex-1">Below minimum loan amount</p>
                  )
                ) : (
                  <>
                    <p className="text-[11px] text-gray-400 mb-0.5">Range</p>
                    <p className="text-sm font-semibold text-gray-700 mb-4">{productRanges[key]}</p>
                  </>
                )}

                {qual && amount === 0 ? null : (
                  <div className="mt-auto">
                    <Link
                      href={`/portal/apply/${key}`}
                      className="block text-center py-2.5 rounded-lg text-sm font-semibold transition-colors"
                        style={featured
                          ? { backgroundColor: "#4F46E5", color: "var(--cf-on-brand)" }
                          : { backgroundColor: "var(--cf-bg-raised)", color: "#4338CA", border: "1px solid var(--cf-border-subtle)" }}
                    >
                      Apply for {key === "po" ? "PO Funding" : title} →
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

function ExploreCalculator({ client }: { client: ClientData | null }) {
  const toR = (cents: number) => Math.round(cents / 100)
  const [income, setIncome] = useState(toR(client?.monthlyIncome ?? 0))
  const [expenses, setExpenses] = useState(toR(client?.monthlyExpenses ?? 0))
  const [debt, setDebt] = useState(toR(client?.existingDebt ?? 0))

  const qual = useMemo(
    () => income > 0 ? computeQualification(income * 100, expenses * 100, debt * 100) : null,
    [income, expenses, debt]
  )

  const inputClass = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
      <h2 className="text-base font-bold text-gray-900 mb-1">Explore Scenarios</h2>
      <p className="text-[12px] text-gray-500 mb-1">Adjust to explore — changes are not saved.</p>
      <p className="text-[11px] text-gray-400 mb-5">These are estimates. Actual approval depends on credit assessment.</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {([
          { label: "Monthly Income (R)", value: income, setter: setIncome },
          { label: "Monthly Expenses (R)", value: expenses, setter: setExpenses },
          { label: "Existing Debt (R)", value: debt, setter: setDebt },
        ] as const).map(({ label, value, setter }) => (
          <div key={label}>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</label>
            <input
              type="number"
              min={0}
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
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">NDI</p>
            <p className="font-bold" style={{ color: ndiColor(qual.ndi) }}>{formatZAR(qual.ndi)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">Micro Loan</p>
            <p className="font-semibold text-gray-800">{qual.microLoan.maxAmount > 0 ? formatZAR(qual.microLoan.maxAmount) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">Personal Loan</p>
            <p className="font-semibold text-gray-800">{qual.personalLoan.maxAmount > 0 ? formatZAR(qual.personalLoan.maxAmount) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">PO Funding</p>
            <p className="font-semibold text-gray-800">{qual.poFunding.maxAmount > 0 ? formatZAR(qual.poFunding.maxAmount) : "—"}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">Max Instalment</p>
            <p className="font-semibold" style={{ color: "#4F46E5" }}>{formatZAR(qual.maxInstalment)}</p>
          </div>
        </div>
      )}
    </div>
  )
}

export function PortalApplyClient({ client, qualification, productRanges }: Props) {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {client ? `Hi ${client.firstName}, here's what you qualify for` : "Qualify & Apply"}
        </h1>
        <p className="text-sm text-gray-500 mt-1">Personalised results based on your profile.</p>
      </div>

      {client ? (
        <AffordabilityCard client={client} qual={qualification} />
      ) : (
          <div className="rounded-xl border border-[var(--cf-border-subtle)] p-5 mb-6 text-sm text-[var(--cf-text-muted)]" style={{ borderLeft: "3px solid #4F46E5" }}>
          Log in with a registered client account to see personalised results.
        </div>
      )}

      <ProductCards qual={qualification} productRanges={productRanges} />

      <ExploreCalculator client={client} />
    </div>
  )
}
