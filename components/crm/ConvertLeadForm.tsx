"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { UserCheck, Briefcase, CreditCard, AlertCircle, CheckCircle } from "lucide-react"
import { LOAN_PURPOSE_OPTIONS } from "@/lib/loan-purpose-categories"

type Product = {
  id: string
  name: string
  productType: string
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
}

type Props = {
  lead: { id: string; firstName: string; lastName: string; email: string; phone: string }
  prefill: Record<string, string>
  products: Product[]
  recoveryMode?: boolean
}

const EMPLOYMENT_OPTIONS = [
  { value: "EMPLOYED", label: "Employed (Salaried)" },
  { value: "SELF_EMPLOYED", label: "Self-Employed" },
  { value: "UNEMPLOYED", label: "Unemployed" },
  { value: "PENSIONER", label: "Pensioner" },
]

function parsePrefillAmount(val: string): number {
  // Handles "R99,000" → 99000, "99000" → 99000
  return parseInt(val.replace(/[^0-9]/g, ""), 10) || 0
}

function parsePrefillEmployment(val: string): string {
  const v = val.toUpperCase().replace(/[^A-Z_]/g, "_")
  const map: Record<string, string> = {
    EMPLOYED: "EMPLOYED",
    SALARIED: "EMPLOYED",
    SELF_EMPLOYED: "SELF_EMPLOYED",
    UNEMPLOYED: "UNEMPLOYED",
    PENSIONER: "PENSIONER",
  }
  return map[v] ?? "EMPLOYED"
}

function parsePrefillProduct(val: string, products: Product[]): string {
  const v = val.toUpperCase()
  if (v === "MICRO") return products.find((p) => p.productType === "MICRO")?.id ?? products[0]?.id ?? ""
  if (v === "PERSONAL") return products.find((p) => p.productType === "PERSONAL")?.id ?? products[0]?.id ?? ""
  if (v === "PO_FUNDING") return products.find((p) => p.productType === "PO_FUNDING")?.id ?? products[0]?.id ?? ""
  return products[0]?.id ?? ""
}

export function ConvertLeadForm({ lead, prefill, products, recoveryMode = false }: Props) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState<{ applicationId: string; reference: string } | null>(null)

  // Step 1 — Client identity
  const [idNumber, setIdNumber] = useState(prefill["ID Number"] ?? "")
  const [firstName, setFirstName] = useState(lead.firstName)
  const [lastName, setLastName] = useState(lead.lastName)
  const [email, setEmail] = useState(lead.email)
  const [phone, setPhone] = useState(lead.phone)

  // Step 2 — Employment & financials
  const [employment, setEmployment] = useState(
    parsePrefillEmployment(prefill["Employment"] ?? "EMPLOYED")
  )
  const [employer, setEmployer] = useState(prefill["Employer"] ?? "")
  const [income, setIncome] = useState(
    parsePrefillAmount(prefill["Monthly Income"] ?? "0").toString()
  )
  const [expenses, setExpenses] = useState(
    parsePrefillAmount(prefill["Monthly Expenses"] ?? "0").toString()
  )

  // Step 3 — Loan details
  const defaultProductId = parsePrefillProduct(prefill["Product"] ?? "", products)
  const [productId, setProductId] = useState(defaultProductId)
  const [amount, setAmount] = useState(
    parsePrefillAmount(prefill["Amount"] ?? "0").toString()
  )
  const [purpose, setPurpose] = useState(prefill["Purpose"] ?? "")
  const [purposeCategory, setPurposeCategory] = useState("OTHER")
  const [recoveryReason, setRecoveryReason] = useState("")

  const selectedProduct = products.find((p) => p.id === productId)

  const handleSubmit = async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idNumber: idNumber.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          employmentStatus: employment,
          employerName: employer.trim() || null,
          monthlyIncome: parseFloat(income) || 0,
          monthlyExpenses: parseFloat(expenses) || 0,
          productId,
          appliedAmount: parseFloat(amount) || 0,
          appliedTermDays: selectedProduct?.maxTermDays ?? 30,
          purpose: purpose.trim() || null,
          loanPurposeCategory: purposeCategory || null,
          recoveryReason: recoveryMode ? recoveryReason.trim() : undefined,
        }),
      })

      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? "Conversion failed")
        setLoading(false)
        return
      }

      if (json.alreadyConverted && !json.applicationId && json.clientId) {
        router.replace(`/clients/${json.clientId}`)
        return
      }
      if (!json.applicationId || !json.applicationReference) {
        setError("The conversion completed, but no application could be located.")
        setLoading(false)
        return
      }

      setSuccess({ applicationId: json.applicationId, reference: json.applicationReference })
    } catch {
      setError("Network error — please try again")
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-10 text-center max-w-lg mx-auto">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
          <CheckCircle className="w-8 h-8 text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          {recoveryMode ? "Conversion Recovered" : "Client Created Successfully"}
        </h2>
        <p className="text-sm text-gray-500 mb-1">
          <strong>{firstName} {lastName}</strong> {recoveryMode ? "now has a recovered, exact application link" : "is now a client with a submitted application"}.
        </p>
        <p className="text-xs text-gray-400 mb-6">Reference: {success.reference}</p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push(`/applications/${success.applicationId}`)}
            className="px-5 py-2 rounded-md text-white text-sm font-medium"
            style={{ backgroundColor: "#4338CA" }}
          >
            View Application
          </button>
          <button
            onClick={() => router.push("/crm/leads")}
            className="px-5 py-2 rounded-md border border-gray-200 text-sm text-gray-600"
          >
            Back to Leads
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Step indicators */}
      <div className="flex items-center gap-3 mb-2">
        {[
          { n: 1, label: "Identity", Icon: UserCheck },
          { n: 2, label: "Financials", Icon: Briefcase },
          { n: 3, label: "Loan", Icon: CreditCard },
        ].map(({ n, label, Icon }) => (
          <div key={n} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                step >= n ? "text-white" : "text-gray-400 bg-gray-100"
              }`}
              style={step >= n ? { backgroundColor: "#4338CA" } : {}}
            >
              <Icon className="w-4 h-4" />
            </div>
            <span className={`text-sm font-medium ${step >= n ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
            {n < 3 && <div className={`w-8 h-px ${step > n ? "bg-amber-400" : "bg-gray-200"}`} />}
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Step 1 — Identity */}
      {step === 1 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Client Identity</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field label="First Name *" value={firstName} onChange={setFirstName} disabled={recoveryMode} />
            <Field label="Last Name *" value={lastName} onChange={setLastName} disabled={recoveryMode} />
          </div>
          <Field label="SA ID Number *" value={idNumber} onChange={setIdNumber} placeholder="13-digit ID number" disabled={recoveryMode} />
          <Field label="Email Address *" value={email} onChange={setEmail} type="email" disabled={recoveryMode} />
          <Field label="Phone Number *" value={phone} onChange={setPhone} type="tel" disabled={recoveryMode} />
          <div className="pt-2 flex justify-end">
            <button
              onClick={() => {
                if (!idNumber || !firstName || !lastName || !email || !phone) {
                  setError("Please complete all required fields")
                  return
                }
                if (!/^\d{13}$/.test(idNumber)) {
                  setError("ID number must be exactly 13 digits")
                  return
                }
                setError("")
                setStep(2)
              }}
              className="px-5 py-2 rounded-md text-white text-sm font-medium"
              style={{ backgroundColor: "#4338CA" }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — Employment & Financials */}
      {step === 2 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Employment & Financials</h2>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Employment Status *</label>
            <select
              value={employment}
              onChange={(e) => setEmployment(e.target.value)}
              disabled={recoveryMode}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              {EMPLOYMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <Field label="Employer / Business Name" value={employer} onChange={setEmployer} placeholder="Optional" disabled={recoveryMode} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Monthly Income (R) *" value={income} onChange={setIncome} type="number" placeholder="0" disabled={recoveryMode} />
            <Field label="Monthly Expenses (R) *" value={expenses} onChange={setExpenses} type="number" placeholder="0" disabled={recoveryMode} />
          </div>
          {income && expenses && (
            <div className="p-3 bg-amber-50 rounded-md text-sm">
              <span className="font-medium text-gray-700">Net Disposable Income: </span>
              <span className="font-bold text-amber-700">
                R {(parseFloat(income) - parseFloat(expenses)).toLocaleString("en-ZA")}
              </span>
            </div>
          )}
          <div className="pt-2 flex justify-between">
            <button onClick={() => { setError(""); setStep(1) }} className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600">← Back</button>
            <button
              onClick={() => {
                if (!income || parseFloat(income) <= 0) {
                  setError("Monthly income must be greater than 0")
                  return
                }
                setError("")
                setStep(3)
              }}
              className="px-5 py-2 rounded-md text-white text-sm font-medium"
              style={{ backgroundColor: "#4338CA" }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Loan Details */}
      {step === 3 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Loan Request</h2>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Loan Product *</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (R{(p.minAmount / 100).toLocaleString()} – R{(p.maxAmount / 100).toLocaleString()})
                </option>
              ))}
            </select>
          </div>
          {recoveryMode && (
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Recovery Reason *</label>
              <textarea
                value={recoveryReason}
                onChange={(event) => setRecoveryReason(event.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
                placeholder="Explain why a replacement application is required."
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Loan Amount (R) * {selectedProduct && `— min R${(selectedProduct.minAmount / 100).toLocaleString()}, max R${(selectedProduct.maxAmount / 100).toLocaleString()}`}
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              placeholder="Enter amount"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Purpose Category</label>
            <select
              value={purposeCategory}
              onChange={(e) => setPurposeCategory(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              {LOAN_PURPOSE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Loan Purpose / Notes</label>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
              placeholder="Client's stated reason..."
            />
          </div>
          <div className="pt-2 flex justify-between">
            <button onClick={() => { setError(""); setStep(2) }} className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600">← Back</button>
            <button
              onClick={() => {
                const a = parseFloat(amount)
                if (!a || a <= 0) { setError("Enter a valid loan amount"); return }
                if (selectedProduct && (a * 100 < selectedProduct.minAmount || a * 100 > selectedProduct.maxAmount)) {
                  setError(`Amount must be between R${(selectedProduct.minAmount / 100).toLocaleString()} and R${(selectedProduct.maxAmount / 100).toLocaleString()}`)
                  return
                }
                if (recoveryMode && recoveryReason.trim().length < 10) {
                  setError("Enter a recovery reason of at least 10 characters")
                  return
                }
                setError("")
                handleSubmit()
              }}
              disabled={loading}
              className="px-6 py-2 rounded-md text-white text-sm font-semibold disabled:opacity-60"
              style={{ backgroundColor: "#16A085" }}
            >
              {loading
                ? (recoveryMode ? "Recovering..." : "Converting...")
                : recoveryMode
                  ? "Resume & Create Application"
                  : "✓ Convert & Create Application"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label, value, onChange, type = "text", placeholder, disabled = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:bg-gray-100 disabled:text-gray-600"
      />
    </div>
  )
}
