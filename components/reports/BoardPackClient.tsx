"use client"

import type { ReactNode } from "react"
import { formatZAR, formatDate } from "@/lib/utils"
import { Printer } from "lucide-react"
import Link from "next/link"

type Loan = {
  id: string; reference: string; principal: number; outstandingPrincipal: number; daysInArrears: number; status: string; startDate: Date | string
  client: { firstName: string; lastName: string }
  product: { name: string; productType: string }
}

type DelinquentAccount = {
  clientName: string
  daysInArrears: number
  arrearsAmount: number
  /** default charges owing, beside the instalment arrears; undefined while charges are not live */
  chargesOwing?: number
  outstandingPrincipal: number
  reference: string
}

type Props = {
  /** The lender's brand and NCR number (lib/config/identity.ts); ncrNumber is null until configured. */
  lenderName: string
  ncrNumber: string | null
  book: number; activeLoans: number; clients: number; collectionsRate: number | null; arrearsRate: string | null
  totalArrears: number; totalDisbursed: number
  buckets: { label: string; count: number; value: number; charges?: number }[]
  topLoans: Loan[]
  productMix: { name: string; type: string; count: number; value: number }[]
  insurancePolicies: number; monthlyPremiums: number
  nplRatio?: string; nplAmount?: number
  par30?: string; par60?: string; par90?: string
  monthlyCollectionRate?: string
  delinquentAccounts?: DelinquentAccount[]
  /** the default charges section; rendered after the arrears aging */
  defaultCharges?: ReactNode
}

const PRODUCT_COLORS: Record<string, string> = {
  MICRO: "#4F46E5",
  PERSONAL: "#1565c0",
  PO_FUNDING: "#1e6b3f",
}

export function BoardPackClient({ lenderName, ncrNumber, book, activeLoans, clients, collectionsRate, arrearsRate, totalArrears, totalDisbursed, buckets, topLoans, productMix, insurancePolicies, monthlyPremiums, nplRatio, nplAmount, par30, par60, par90, monthlyCollectionRate, delinquentAccounts, defaultCharges }: Props) {
  const maxVal = Math.max(...productMix.map(p => p.value), 1)

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Board Pack</h1>
          {/* Every figure is live; there is no history to pick a past month from. */}
          <p className="text-sm text-gray-500 mt-1">Executive portfolio summary for board presentation, as at {formatDate(new Date())}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA]">
            <Printer className="h-4 w-4" /> Print / PDF
          </button>
          <Link href="/reports" className="text-sm text-gray-500 hover:text-gray-700 print:hidden">← Reports</Link>
        </div>
      </div>

      {/* Print header (hidden on screen) */}
      <div className="hidden print:block mb-8 pb-4 border-b-2 border-[#4F46E5]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#1b1d24]">{lenderName}</h1>
            <p className="text-lg text-gray-600">Board Pack — as at {formatDate(new Date())}</p>
          </div>
          <div className="text-right text-sm text-gray-500">
            <p>NCR Reg: {ncrNumber ?? "not configured"}</p>
            <p>Confidential — Board Use Only</p>
            <p>Generated: {formatDate(new Date())}</p>
          </div>
        </div>
      </div>

      {/* 1. Executive Summary KPIs */}
      <div className="mb-6">
        <h2 className="text-lg font-bold text-[#1b1d24] mb-3">1. Executive Summary</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Loan Book", value: formatZAR(book), sub: `${activeLoans} active loans`, color: "#4F46E5" },
            { label: "Active Clients", value: String(clients), sub: "With an active loan", color: "#1565c0" },
            collectionsRate === null
              ? { label: "Accounts Up To Date", value: "—", sub: "Data anomaly — see server logs", color: "#6b7280" }
              : { label: "Accounts Up To Date", value: `${collectionsRate}%`, sub: "Collectible accounts with no arrears", color: collectionsRate >= 80 ? "#1e6b3f" : "#e65100" },
            arrearsRate === null
              ? { label: "Arrears Rate", value: "—", sub: "Data anomaly — see server logs", color: "#6b7280" }
              : { label: "Arrears Rate", value: `${arrearsRate}%`, sub: `Principal of accounts in arrears ÷ collectible book; ${formatZAR(totalArrears)} unpaid instalments`, color: parseFloat(arrearsRate) < 10 ? "#1e6b3f" : "#b71c1c" },
          ].map(k => (
            <div key={k.label} className="bg-white rounded-xl shadow-sm p-5" style={{ borderLeft: `4px solid ${k.color}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">{k.label}</p>
              <p className="whitespace-nowrap text-2xl font-extrabold text-[#1b1d24]">{k.value}</p>
              <p className="text-[11px] text-gray-400 mt-1">{k.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Product Mix */}
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-bold text-[#1b1d24] mb-4">2. Portfolio Composition</h2>
        <div className="space-y-3">
          {productMix.map(p => (
            <div key={p.name}>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-[#1b1d24]">{p.name}</span>
                <span className="text-gray-500">{p.count} loans — <span className="whitespace-nowrap">{formatZAR(p.value)}</span></span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{ width: `${Math.round((p.value / maxVal) * 100)}%`, backgroundColor: PRODUCT_COLORS[p.type] || "#4F46E5" }} />
              </div>
            </div>
          ))}
          {productMix.length === 0 && <p className="text-gray-400 text-sm">No active loans</p>}
        </div>
      </div>

      {/* 3. Top 10 Loans */}
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-[#1b1d24]">3. Top 10 Loans by Principal</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-4 py-3 text-left">Ref</th>
              <th className="px-4 py-3 text-left">Client</th>
              <th className="px-4 py-3 text-left">Product</th>
              <th className="px-4 py-3 text-right">Principal</th>
              <th className="px-4 py-3 text-right">Outstanding</th>
              <th className="px-4 py-3 text-center">DPD</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {topLoans.map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 font-mono text-xs text-[#4F46E5]">{l.reference.slice(-12)}</td>
                <td className="px-4 py-2.5 font-medium">{l.client.firstName} {l.client.lastName}</td>
                <td className="px-4 py-2.5 text-gray-600">{l.product.name}</td>
                <td className="px-4 py-2.5 text-right">{formatZAR(l.principal)}</td>
                <td className="px-4 py-2.5 text-right font-semibold">{formatZAR(l.outstandingPrincipal)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${l.daysInArrears === 0 ? "bg-green-100 text-green-800" : l.daysInArrears <= 30 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                    {l.daysInArrears}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 4. Arrears Aging */}
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-bold text-[#1b1d24] mb-4">4. Arrears Aging Analysis</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {buckets.map((b, i) => {
            const colors = ["#F59E0B", "#9A3412", "#B91C1C", "#7F1D1D"]
            return (
              <div
                key={b.label}
                className="rounded-xl p-4"
                style={{ backgroundColor: colors[i], color: i === 0 ? "#101112" : "#fff" }}
              >
                <p className="text-xs font-semibold opacity-80 mb-1">{b.label}</p>
                <p className="text-2xl font-extrabold">{b.count}</p>
                <p className="whitespace-nowrap text-xs opacity-80 mt-1">{formatZAR(b.value)}</p>
                {b.charges !== undefined && <p className="whitespace-nowrap text-[10px] opacity-70">+ {formatZAR(b.charges)} default charges</p>}
              </div>
            )
          })}
        </div>
      </div>

      {defaultCharges}

      {/* 5. Credit Quality */}
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-bold text-[#1b1d24] mb-4">5. Credit Quality Indicators</h2>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="text-center p-4 rounded-xl" style={{ backgroundColor: parseFloat(nplRatio || "0") >= 5 ? "#FEE2E2" : parseFloat(nplRatio || "0") >= 2 ? "#FEF3C7" : "#DCFCE7" }}>
            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-1">NPL Ratio</p>
            <p className={`text-2xl font-extrabold ${parseFloat(nplRatio || "0") >= 5 ? "text-red-700" : parseFloat(nplRatio || "0") >= 2 ? "text-orange-700" : "text-green-700"}`}>
              {nplRatio || "0.0"}%
            </p>
            <p className="whitespace-nowrap text-[10px] text-gray-500 mt-1">{formatZAR(nplAmount || 0)}</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-xl">
            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-1">PAR30</p>
            <p className="text-2xl font-extrabold text-gray-800">{par30 || "0.0"}%</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-xl">
            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-1">PAR60</p>
            <p className="text-2xl font-extrabold text-gray-800">{par60 || "0.0"}%</p>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-xl">
            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-1">PAR90</p>
            <p className="text-2xl font-extrabold text-gray-800">{par90 || "0.0"}%</p>
          </div>
          <div className="text-center p-4 rounded-xl" style={{ backgroundColor: parseFloat(monthlyCollectionRate || "100") >= 95 ? "#DCFCE7" : parseFloat(monthlyCollectionRate || "100") >= 85 ? "#FEF3C7" : "#FEE2E2" }}>
            <p className="text-[10px] font-semibold uppercase text-gray-500 mb-1">Collection Rate</p>
            <p className={`text-2xl font-extrabold ${parseFloat(monthlyCollectionRate || "100") >= 95 ? "text-green-700" : parseFloat(monthlyCollectionRate || "100") >= 85 ? "text-orange-700" : "text-red-700"}`}>
              {monthlyCollectionRate || "100.0"}%
            </p>
            <p className="text-[10px] text-gray-500 mt-1">Current month</p>
          </div>
        </div>
      </div>

      {/* 6. Top Delinquent Accounts */}
      {delinquentAccounts && delinquentAccounts.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-bold text-[#1b1d24]">6. Top Delinquent Accounts (30+ DPD)</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                <th className="px-4 py-3 text-left">Reference</th>
                <th className="px-4 py-3 text-left">Client</th>
                <th className="px-4 py-3 text-center">DPD</th>
                <th className="px-4 py-3 text-right">Arrears</th>
                {delinquentAccounts.some((a) => a.chargesOwing !== undefined) && <th className="px-4 py-3 text-right">Default charges</th>}
                <th className="px-4 py-3 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {delinquentAccounts.map((a) => (
                <tr key={a.reference} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-[#4F46E5]">{a.reference.slice(-12)}</td>
                  <td className="px-4 py-2.5 font-medium">{a.clientName}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-800">{a.daysInArrears}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-red-600">{formatZAR(a.arrearsAmount)}</td>
                  {a.chargesOwing !== undefined && <td className="px-4 py-2.5 text-right">{formatZAR(a.chargesOwing)}</td>}
                  <td className="px-4 py-2.5 text-right">{formatZAR(a.outstandingPrincipal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 7. Insurance Summary */}
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-bold text-[#1b1d24] mb-4">7. Insurance Portfolio</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-4 bg-amber-50 rounded-xl">
            <p className="text-3xl font-extrabold text-[#4F46E5]">{insurancePolicies}</p>
            <p className="text-sm text-gray-600 mt-1">Active Policies</p>
          </div>
          <div className="text-center p-4 bg-green-50 rounded-xl">
            <p className="whitespace-nowrap text-2xl font-extrabold text-green-700">{formatZAR(monthlyPremiums * 100)}</p>
            <p className="text-sm text-gray-600 mt-1">Monthly Premiums</p>
          </div>
          <div className="text-center p-4 bg-blue-50 rounded-xl">
            <p className="whitespace-nowrap text-2xl font-extrabold text-blue-700">{formatZAR(totalDisbursed)}</p>
            <p className="text-sm text-gray-600 mt-1">Total Disbursed (All time)</p>
          </div>
        </div>
      </div>

      {/* Print footer */}
      <div className="hidden print:block mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400 text-center">
        {lenderName} | NCR Reg: {ncrNumber ?? "not configured"} | Confidential — Board Use Only | As at {formatDate(new Date())}
      </div>

      <style>{`@media print { .print\\:hidden { display: none !important; } .print\\:block { display: block !important; } nav, aside, [class*="sidebar"], [class*="topbar"] { display: none !important; } }`}</style>
    </div>
  )
}
