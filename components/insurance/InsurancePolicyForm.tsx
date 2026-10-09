"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"

interface InsuranceProduct {
  id: string
  code: string
  name: string
  type: string
  premiumAmount: number
  sumAssured: number
  commissionRate: number
  active: boolean
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  LIFE_INSURANCE: "Life Insurance",
  SHORT_TERM_MOTOR: "Short-term Motor",
  SHORT_TERM_HOME: "Short-term Home",
  SHORT_TERM_CONTENTS: "Short-term Contents",
  BUSINESS_INSURANCE: "Business Insurance",
}

const INSURERS: Record<string, string> = {
  FUNERAL_COVER: "Guardrisk Life",
  CREDIT_LIFE: "Clientele Life",
  LIFE_INSURANCE: "Old Mutual",
  SHORT_TERM_MOTOR: "Santam",
  SHORT_TERM_HOME: "Santam",
  SHORT_TERM_CONTENTS: "Santam",
  BUSINESS_INSURANCE: "Hollard",
}

function formatR(n: number) {
  return "R " + n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function InsurancePolicyForm() {
  const router = useRouter()
  const [products, setProducts] = useState<InsuranceProduct[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [selectedProductId, setSelectedProductId] = useState<string>("")
  const [useProduct, setUseProduct] = useState<"catalogue" | "manual">("catalogue")
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    clientEmail: "",
    type: "FUNERAL_COVER",
    insurer: "Guardrisk Life",
    sumAssured: "",
    premiumAmount: "",
    commissionRate: "15",
    startDate: new Date().toISOString().slice(0, 10),
    linkedLoanRef: "",
    productId: "",
    // Motor risk fields
    vehicleRegNumber: "",
    vehicleValue: "",
    vehicleUse: "PRIVATE",
    // Home / contents risk fields
    propertyAddress: "",
    constructionType: "BRICK",
    propertyValue: "",
  })
  const [validationError, setValidationError] = useState<string | null>(null)

  const set = (k: string, v: string) => {
    const update = { ...form, [k]: v }
    if (k === "type") update.insurer = INSURERS[v] || ""
    setForm(update)
  }

  useEffect(() => {
    fetch("/api/products/insurance")
      .then(r => r.json())
      .then(data => { setProducts(Array.isArray(data) ? data.filter((p: InsuranceProduct) => p.active) : []); setLoadingProducts(false) })
      .catch(() => setLoadingProducts(false))
  }, [])

  function applyProduct(product: InsuranceProduct) {
    setSelectedProductId(product.id)
    setForm(f => ({
      ...f,
      type: product.type,
      insurer: INSURERS[product.type] || "",
      sumAssured: product.sumAssured.toString(),
      premiumAmount: product.premiumAmount.toString(),
      commissionRate: (product.commissionRate * 100).toFixed(2),
      productId: product.id,
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setValidationError(null)

    // ── Task 5: Client-side cover range validation ─────────────────────────
    const sumAssuredVal = parseFloat(form.sumAssured)
    if (form.type === "LIFE_INSURANCE") {
      if (isNaN(sumAssuredVal) || sumAssuredVal < 100000 || sumAssuredVal > 5000000) {
        setValidationError("Life Insurance sum assured must be between R100,000 and R5,000,000.")
        setLoading(false)
        return
      }
    }
    if (form.type === "CREDIT_LIFE" && form.linkedLoanRef) {
      // Server will validate against the loan; we just surface the result below
    }

    try {
      const res = await fetch("/api/insurance/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          sumAssured: Math.round(parseFloat(form.sumAssured) * 100),
          premiumAmount: Math.round(parseFloat(form.premiumAmount) * 100),
          commissionRate: parseFloat(form.commissionRate) / 100,
          productId: form.productId || null,
          vehicleRegNumber: form.vehicleRegNumber || null,
          vehicleValue: form.vehicleValue ? parseFloat(form.vehicleValue) : null,
          vehicleUse: form.vehicleUse || null,
          propertyAddress: form.propertyAddress || null,
          constructionType: form.constructionType || null,
          propertyValue: form.propertyValue ? parseFloat(form.propertyValue) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create policy")
      setSuccess(data.policyNumber)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error")
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl">✓</span>
        </div>
        <h2 className="text-xl font-bold text-[#1b1d24] mb-2">Policy Issued Successfully</h2>
        <p className="text-gray-500 mb-6">Policy number: <span className="font-mono font-bold text-[#4F46E5]">{success}</span></p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => router.push("/insurance")} className="px-6 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA]">
            View All Policies
          </button>
          <button onClick={() => {
            setSuccess(null)
            setForm({ ...form, clientEmail: "", productId: "", linkedLoanRef: "", vehicleRegNumber: "", vehicleValue: "", propertyAddress: "", propertyValue: "" })
            setSelectedProductId("")
            setValidationError(null)
          }}
            className="px-6 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50">
            Issue Another
          </button>
        </div>
      </div>
    )
  }

  const inp = "w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
  const lbl = "block text-xs font-semibold text-gray-600 mb-1.5"

  const hasProducts = products.length > 0

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Mode toggle */}
      {hasProducts && (
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Product Source</p>
          <div className="grid grid-cols-2 gap-3">
            {([["catalogue", "📋 From Product Catalogue", "Select a pre-configured product — rates auto-fill"],
               ["manual", "✏️ Manual Entry", "Enter all fields manually"]] as const).map(([val, title, desc]) => (
              <label key={val} className={`cursor-pointer p-3 rounded-xl border-2 transition-colors ${useProduct === val ? "border-[#4F46E5] bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}>
                <input type="radio" name="useProduct" value={val} checked={useProduct === val} onChange={() => setUseProduct(val)} className="sr-only" />
                <p className="font-semibold text-sm text-[#1b1d24]">{title}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">{desc}</p>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Product catalogue selector */}
      {useProduct === "catalogue" && hasProducts && (
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Select Product</p>
          {loadingProducts ? (
            <p className="text-sm text-gray-400">Loading products…</p>
          ) : (
            <div className="space-y-2">
              {products.map(p => (
                <label key={p.id} className={`flex items-center justify-between p-3 rounded-xl border-2 cursor-pointer transition-colors ${selectedProductId === p.id ? "border-[#4F46E5] bg-amber-50" : "border-gray-100 hover:border-gray-200"}`}>
                  <input type="radio" name="product" value={p.id} checked={selectedProductId === p.id} onChange={() => applyProduct(p)} className="sr-only" />
                  <div>
                    <p className="font-semibold text-sm text-[#1b1d24]">{p.name}</p>
                    <p className="text-xs text-gray-400">{p.code} · {TYPE_LABELS[p.type] || p.type}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-[#4F46E5]">{formatR(p.premiumAmount)}<span className="text-xs font-normal text-gray-400">/mo</span></p>
                    <p className="text-xs text-gray-400">Cover: {formatR(p.sumAssured)}</p>
                  </div>
                </label>
              ))}
              {selectedProductId && (
                <div className="mt-3 p-3 bg-amber-50 border border-[#4F46E5]/20 rounded-xl text-xs text-[#4F46E5] font-medium">
                  ✓ Product selected — premium, sum assured and commission auto-filled below. You can still edit.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Policy details */}
      <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Policy Details</p>

        <div>
          <label className={lbl}>Client Email *</label>
          <input className={inp} type="email" placeholder="client@example.com" required value={form.clientEmail} onChange={e => set("clientEmail", e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Policy Type *</label>
            <select className={inp} value={form.type} onChange={e => set("type", e.target.value)}>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Insurer</label>
            <input className={inp} value={form.insurer} onChange={e => set("insurer", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Sum Assured (R) *</label>
            <input className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text" inputMode="decimal" required placeholder="50000"
              value={form.sumAssured} onChange={e => { set("sumAssured", e.target.value.replace(",", ".")); setValidationError(null) }} />
            {form.type === "LIFE_INSURANCE" && (
              <p className="text-[11px] text-gray-400 mt-1">Must be between R100,000 and R5,000,000</p>
            )}
          </div>
          <div>
            <label className={lbl}>Monthly Premium (R) *</label>
            <input className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text" inputMode="decimal" required placeholder="150"
              value={form.premiumAmount} onChange={e => set("premiumAmount", e.target.value.replace(",", "."))} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Commission Rate (%)</label>
            <input className={`${inp} ${selectedProductId ? "bg-amber-50/50" : ""}`}
              type="text" inputMode="decimal"
              value={form.commissionRate} onChange={e => set("commissionRate", e.target.value.replace(",", "."))} />
            {form.sumAssured && form.commissionRate && (
              <p className="text-[11px] text-gray-400 mt-1">
                Commission: {formatR(parseFloat(form.sumAssured || "0") * parseFloat(form.commissionRate || "0") / 100)}
              </p>
            )}
          </div>
          <div>
            <label className={lbl}>Start Date *</label>
            <input className={inp} type="date" required value={form.startDate} onChange={e => set("startDate", e.target.value)} />
          </div>
        </div>

        <div>
          <label className={lbl}>Link to Loan Reference (optional)</label>
          <input className={inp} placeholder="LN-…" value={form.linkedLoanRef} onChange={e => set("linkedLoanRef", e.target.value)} />
          <p className="text-[11px] text-gray-400 mt-1">For credit life policies — links policy to an existing loan</p>
        </div>
      </div>

      {/* Motor risk fields — shown only for SHORT_TERM_MOTOR */}
      {form.type === "SHORT_TERM_MOTOR" && (
        <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Motor Vehicle Details</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Registration Number</label>
              <input className={inp} placeholder="CA 123-456" value={form.vehicleRegNumber} onChange={e => set("vehicleRegNumber", e.target.value)} />
            </div>
            <div>
              <label className={lbl}>Vehicle Value (R)</label>
              <input className={inp} type="text" inputMode="decimal" placeholder="250000" value={form.vehicleValue} onChange={e => set("vehicleValue", e.target.value.replace(",", "."))} />
            </div>
          </div>
          <div>
            <label className={lbl}>Vehicle Use</label>
            <select className={`${inp} bg-white`} value={form.vehicleUse} onChange={e => set("vehicleUse", e.target.value)}>
              <option value="PRIVATE">Private</option>
              <option value="BUSINESS">Business</option>
              <option value="COMMUTE">Commute</option>
            </select>
          </div>
        </div>
      )}

      {/* Property risk fields — shown for SHORT_TERM_HOME and SHORT_TERM_CONTENTS */}
      {(form.type === "SHORT_TERM_HOME" || form.type === "SHORT_TERM_CONTENTS") && (
        <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Property Details</p>
          <div>
            <label className={lbl}>Property Address</label>
            <input className={inp} placeholder="123 Main St, Cape Town" value={form.propertyAddress} onChange={e => set("propertyAddress", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Construction Type</label>
              <select className={`${inp} bg-white`} value={form.constructionType} onChange={e => set("constructionType", e.target.value)}>
                <option value="BRICK">Brick</option>
                <option value="TIMBER">Timber</option>
                <option value="MIXED">Mixed</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Property Value (R)</label>
              <input className={inp} type="text" inputMode="decimal" placeholder="1500000" value={form.propertyValue} onChange={e => set("propertyValue", e.target.value.replace(",", "."))} />
            </div>
          </div>
        </div>
      )}

      {/* Cover range validation error */}
      {validationError && (
        <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">{validationError}</p>
      )}

      {error && <p className="text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">{error}</p>}

      <button type="submit" disabled={loading || (useProduct === "catalogue" && hasProducts && !selectedProductId && !form.sumAssured)}
        className="w-full py-3 bg-[#4F46E5] text-white rounded-xl font-semibold text-sm hover:bg-[#4338CA] disabled:opacity-50 transition-colors">
        {loading ? "Issuing Policy…" : "Issue Policy"}
      </button>
    </form>
  )
}
