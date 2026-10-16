"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR } from "@/lib/utils"
import { premiumCommission } from "@/lib/insurance/commission"
import Link from "next/link"

type InsuranceProduct = {
  id?: string; code: string; name: string; type: string
  premiumAmount: number; sumAssured: number; commissionRate: number; active: boolean
  insurerId?: string | null
}

const POLICY_TYPES = [
  { value: "FUNERAL_COVER", label: "Funeral Cover" },
  { value: "CREDIT_LIFE", label: "Credit Life" },
  { value: "LIFE_INSURANCE", label: "Life Insurance" },
  { value: "SHORT_TERM_MOTOR", label: "Short-Term: Motor" },
  { value: "SHORT_TERM_HOME", label: "Short-Term: Home" },
  { value: "SHORT_TERM_CONTENTS", label: "Short-Term: Contents" },
  { value: "BUSINESS_INSURANCE", label: "Business Insurance" },
]

const EMPTY: InsuranceProduct = {
  code: "", name: "", type: "FUNERAL_COVER",
  premiumAmount: 0, sumAssured: 0, commissionRate: 0.15, active: true, insurerId: null
}

export function InsuranceProductForm(
  { initial, insurers }: { initial?: InsuranceProduct; insurers: { id: string; name: string }[] },
) {
  const router = useRouter()
  const [form, setForm] = useState<InsuranceProduct>(initial ?? EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const set = (k: keyof InsuranceProduct, v: string | number | boolean) => setForm(f => ({ ...f, [k]: v }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError("")
    try {
      const url = form.id ? `/api/products/insurance/${form.id}` : "/api/products/insurance"
      const method = form.id ? "PUT" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      if (!res.ok) throw new Error(await res.text())
      router.push("/settings/products/insurance")
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/settings/products/insurance" className="text-sm text-gray-500 hover:text-gray-700">← Insurance Products</Link>
        <h1 className="text-xl font-bold text-[#1b1d24]">{form.id ? "Edit" : "New"} Insurance Product</h1>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>}

      <form onSubmit={save} className="bg-white rounded-2xl shadow-sm p-6 space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-[#1b1d24] mb-1">Product Code</label>
            <input value={form.code} onChange={e => set("code", e.target.value)} required
              placeholder="e.g. FUN-BASIC"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1b1d24] mb-1">Product Name</label>
            <input value={form.name} onChange={e => set("name", e.target.value)} required
              placeholder="e.g. Funeral Cover Basic"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1b1d24] mb-1">Policy Type</label>
          <select value={form.type} onChange={e => set("type", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]">
            {POLICY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-[#1b1d24] mb-1">Underwriter</label>
          <select value={form.insurerId ?? ""} onChange={e => set("insurerId", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]">
            <option value="">— None —</option>
            {insurers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            Sets the insurer + commission on auto-bundled Credit Life policies. Required for Credit Life products.
          </p>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Pricing</p>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#1b1d24] mb-1">Monthly Premium (R)</label>
              <input type="number" step="0.01" value={form.premiumAmount} onChange={e => set("premiumAmount", parseFloat(e.target.value) || 0)} required
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1b1d24] mb-1">Sum Assured (R)</label>
              <input type="number" step="0.01" value={form.sumAssured} onChange={e => set("sumAssured", parseFloat(e.target.value) || 0)} required
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1b1d24] mb-1">Commission Rate (%)</label>
              <input type="number" step="0.01" min="0" max="100" value={(form.commissionRate * 100).toFixed(2)}
                onChange={e => set("commissionRate", parseFloat(e.target.value) / 100 || 0)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5]" />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Commission per policy: {formatZAR(Math.round(premiumCommission(form.premiumAmount, form.commissionRate) * 100))} a month
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)}
              className="h-4 w-4 rounded accent-[#4F46E5]" />
            <span className="text-sm font-medium text-[#1b1d24]">Active (available for new policies)</span>
          </label>
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
          <Link href="/settings/products/insurance"
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
