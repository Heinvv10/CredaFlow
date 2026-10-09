"use client"

import { useState } from "react"
import { CheckCircle, Loader2 } from "lucide-react"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"

const inputClass =
  "w-full border border-white/12 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"

const COVER_OPTIONS = [
  { value: "MOTOR", label: "Vehicle" },
  { value: "HOME", label: "Home / buildings" },
  { value: "CONTENTS", label: "Household contents" },
  { value: "OTHER", label: "Not sure yet" },
] as const

export function InsuranceEnquiryForm() {
  const identity = useWebsiteIdentity()
  const [form, setForm] = useState({ name: "", phone: "", email: "", coverType: "MOTOR" })
  const [consent, setConsent] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/website/insurance-enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, consent, turnstileToken }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not send your enquiry. Please try again.")
        return
      }
      setSent(true)
    } catch {
      setError("Could not send your enquiry. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="flex items-start gap-3 border border-[#a5b4fc]/30 bg-[#a5b4fc]/10 px-5 py-4">
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#a5b4fc]" />
        <div>
          <p className="text-sm font-semibold text-white">Enquiry received</p>
          <p className="mt-1 text-sm text-white/72">
            An adviser from {identity.tradingName} will contact you to discuss your options. Insurance is issued by the underwriter under
            its own terms.
          </p>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full Name *">
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Thandi Mokoena"
            required
          />
        </Field>
        <Field label="Phone Number *">
          <input
            className={inputClass}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="e.g. 071 234 5678"
            required
          />
        </Field>
      </div>
      <Field label="Email Address">
        <input
          className={inputClass}
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="you@example.com"
        />
      </Field>
      <Field label="What would you like to insure?">
        <select
          className={inputClass}
          value={form.coverType}
          onChange={(e) => setForm({ ...form, coverType: e.target.value })}
        >
          {COVER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#11141b]">
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {/* POPIA: states exactly what happens to the details — an adviser from the lender
          makes contact. It deliberately does NOT mention passing data to a quote
          provider, because this form does not do that. If that ever changes, the
          consent text has to change with it. */}
      <label className="flex cursor-pointer items-start gap-3 text-xs leading-5 text-white/64">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[#a5b4fc]"
        />
        <span>
          I agree that {identity.tradingName} may store these details and contact me about this insurance enquiry. {identity.tradingName} is
          a FAIS-authorised intermediary — it discusses options and routes the enquiry; the underwriter issues the
          policy on its own terms.
        </span>
      </label>

      <TurnstileWidget
        onToken={setTurnstileToken}
        onError={() => setTurnstileToken(null)}
        onExpired={() => setTurnstileToken(null)}
      />

      {error && <p className="border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p>}

      <button
        disabled={loading || !turnstileToken || !consent}
        className="flex w-full items-center justify-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-bold text-[#11141b] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30"
      >
        {loading ? <Loader2 size={18} className="animate-spin" /> : null}
        {loading ? "Sending..." : "Request a call back"}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.14em] text-white/56">{label}</span>
      {children}
    </label>
  )
}
