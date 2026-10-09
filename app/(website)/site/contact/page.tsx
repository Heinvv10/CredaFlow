"use client"
import { CheckCircle, Clock, Loader2, Mail, MapPin, MessageCircle, Phone, type LucideIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { contactFaqs } from "./faqs"

const inputClass = "w-full border border-white/12 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"

// Pre-fills the message when a product page links here with ?enquiry=<key>
// (e.g. the credit page's invoice-discounting enquiry CTA).
const ENQUIRY_PREFILL: Record<string, string> = {
  "invoice-discounting": "I'd like to enquire about invoice discounting for my business.",
}

export default function ContactPage() {
  const identity = useWebsiteIdentity()
  const [form, setForm] = useState({ name: "", phone: "", email: "", message: "" })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("enquiry") ?? ""
    const prefill = ENQUIRY_PREFILL[key]
    if (prefill) setForm((f) => (f.message ? f : { ...f, message: prefill }))
  }, [])

  function validate() {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = "Name is required"
    if (!/^\+?[\d\s-]{10,}$/.test(form.phone)) e.phone = "Enter a valid phone number"
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Enter a valid email address"
    if (!form.message.trim()) e.message = "Message is required"
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    if (!turnstileToken) return setErrors({ submit: "Please complete the verification challenge before submitting." })
    setLoading(true)
    try {
      const res = await fetch("/api/website/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, turnstileToken }) })
      const data = await res.json()
      if (data.success) setSent(true)
      else setErrors({ submit: data.error ?? "Something went wrong. Please try again." })
    } catch {
      setErrors({ submit: "Network error. Please try again." })
    } finally {
      setLoading(false)
    }
  }

  const contactItems: Array<[LucideIcon, string, string, string]> = [
    [Phone, "Phone", identity.publicPhone, `tel:${identity.publicPhoneE164}`],
    [Mail, "Email", identity.publicEmail, `mailto:${identity.publicEmail}`],
    ...(identity.publicWhatsapp && identity.publicWhatsappE164
      ? [[MessageCircle, "WhatsApp", identity.publicWhatsapp, `https://wa.me/${identity.publicWhatsappE164.replace("+", "")}`] as [LucideIcon, string, string, string]]
      : []),
    [MapPin, "Office", identity.registeredOfficeLines.join("\n"), ""],
  ]

  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <section className="relative overflow-hidden px-4 py-16 md:py-20">
        <div className="absolute inset-0 bg-[#11141b]/38" />
        <div className="absolute inset-0 bg-linear-to-r from-[#11141b] via-[#11141b]/76 to-[#11141b]/8" />
        <div className="relative mx-auto max-w-6xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-[#a5b4fc]">Contact {identity.tradingName}</p>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">Speak to a financial services team that responds.</h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/64 md:text-base">Ask about applications, documents, repayments, insurance enquiries or client portal support.</p>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/64 md:text-base">
            The fastest way to reach us is by phone on {identity.publicPhone}
            {identity.publicWhatsapp ? <> or WhatsApp on {identity.publicWhatsapp}</> : null} during business hours.
            You can also email {identity.publicEmail} or use the form below. We aim to respond within one business day.
          </p>
        </div>
      </section>
      <section id="complaints" className="mx-auto grid max-w-6xl scroll-mt-24 gap-6 px-4 py-10 lg:grid-cols-[0.85fr_1.15fr]">
        <aside className="space-y-4">
          {contactItems.map(([Icon, label, value, href]) => (
            <div key={label} className="border border-white/12 bg-white/[0.035] p-5">
              <Icon className="mb-4 text-[#a5b4fc]" size={24} />
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-white/38">{label}</p>
              {href ? <a href={href} className="mt-2 block font-semibold text-white hover:text-[#a5b4fc]">{value}</a> : <p className="mt-2 whitespace-pre-line font-semibold text-white">{value}</p>}
            </div>
          ))}
          {/* Hours are Monday–Friday only (no Saturday).
              The /site/contact/faqs.ts "office hours" answer must stay in sync with this. */}
          <div className="border border-white/12 bg-white/[0.035] p-5">
            <Clock className="mb-4 text-[#a5b4fc]" size={24} />
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-white/38">Business hours</p>
            <div className="mt-3 space-y-2 text-sm text-white/62">
              <p>Monday - Friday: 08:00 - 17:00</p>
              <p>Weekends and public holidays: Closed</p>
            </div>
          </div>
        </aside>
        <div className="border border-white/12 bg-[#11141b]/78 p-6 shadow-[0_24px_90px_rgba(0,0,0,0.38)]">
          {sent ? (
            <div className="py-12 text-center">
              <CheckCircle className="mx-auto mb-5 text-[#a5b4fc]" size={52} />
              <h2 className="text-3xl font-semibold">Message sent</h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-white/60">Thank you. The team will respond within one business day.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <h2 className="text-2xl font-semibold">Send a message</h2>
              <Field label="Full Name *" error={errors.name}><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your full name" /></Field>
              <Field label="Phone Number *" error={errors.phone}><input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. 071 234 5678" /></Field>
              <Field label="Email Address *" error={errors.email}><input className={inputClass} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" /></Field>
              <Field label="Message *" error={errors.message}><textarea className={`${inputClass} min-h-32 resize-none`} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="How can we help you?" /></Field>
              <TurnstileWidget onToken={setTurnstileToken} onError={() => setTurnstileToken(null)} onExpired={() => setTurnstileToken(null)} />
              {errors.submit && <p className="border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{errors.submit}</p>}
              <button disabled={loading || !turnstileToken} className="flex w-full items-center justify-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-bold text-[#11141b] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30">
                {loading ? <Loader2 size={18} className="animate-spin" /> : null}
                {loading ? "Sending..." : "Send message"}
              </button>
            </form>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20 pt-4">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">Contact FAQ</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          Before you reach out
        </h2>
        <div className="mt-8">
          <FaqAccordion items={contactFaqs(identity)} />
        </div>
      </section>
    </main>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <div><label className="mb-1.5 block text-sm font-semibold text-white/78">{label}</label>{children}{error && <p className="mt-1 text-xs text-red-300">{error}</p>}</div>
}
