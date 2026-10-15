"use client"
import { CheckCircle, Clock, Loader2, Mail, MapPin, MessageCircle, Phone, type LucideIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { useT } from "@/lib/i18n/client"
import type { MessageKey } from "@/lib/i18n/translate"
import { contactFaqs } from "./faqs"

const inputClass = "w-full border border-white/12 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"

// Pre-fills the message when a product page links here with ?enquiry=<key>
// (e.g. the credit page's invoice-discounting enquiry CTA).
const ENQUIRY_PREFILL: Record<string, MessageKey<"websiteContact">> = {
  "invoice-discounting": "prefillInvoiceDiscounting",
}

export default function ContactPage() {
  const identity = useWebsiteIdentity()
  const t = useT("websiteContact")
  const [form, setForm] = useState({ name: "", phone: "", email: "", message: "" })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("enquiry") ?? ""
    const prefill = ENQUIRY_PREFILL[key]
    if (prefill) setForm((f) => (f.message ? f : { ...f, message: t(prefill) }))
  }, [t])

  function validate() {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = t("errName")
    if (!/^\+?[\d\s-]{10,}$/.test(form.phone)) e.phone = t("errPhone")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = t("errEmail")
    if (!form.message.trim()) e.message = t("errMessage")
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    if (!turnstileToken) return setErrors({ submit: t("errTurnstile") })
    setLoading(true)
    try {
      const res = await fetch("/api/website/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, turnstileToken }) })
      const data = await res.json()
      if (data.success) setSent(true)
      else setErrors({ submit: data.error ?? t("errGeneric") })
    } catch {
      setErrors({ submit: t("errNetwork") })
    } finally {
      setLoading(false)
    }
  }

  const contactItems: Array<[LucideIcon, string, string, string]> = [
    [Phone, t("phone"), identity.publicPhone, `tel:${identity.publicPhoneE164}`],
    [Mail, t("email"), identity.publicEmail, `mailto:${identity.publicEmail}`],
    ...(identity.publicWhatsapp && identity.publicWhatsappE164
      ? [[MessageCircle, t("whatsapp"), identity.publicWhatsapp, `https://wa.me/${identity.publicWhatsappE164.replace("+", "")}`] as [LucideIcon, string, string, string]]
      : []),
    [MapPin, t("office"), identity.registeredOfficeLines.join("\n"), ""],
  ]

  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <section className="relative overflow-hidden px-4 py-16 md:py-20">
        <div className="absolute inset-0 bg-[#11141b]/38" />
        <div className="absolute inset-0 bg-linear-to-r from-[#11141b] via-[#11141b]/76 to-[#11141b]/8" />
        <div className="relative mx-auto max-w-6xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("eyebrow", { brand: identity.tradingName })}</p>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">{t("heading")}</h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/64 md:text-base">{t("intro")}</p>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/64 md:text-base">
            {identity.publicWhatsapp
              ? t("reachPhoneWhatsapp", { phone: identity.publicPhone, whatsapp: identity.publicWhatsapp, email: identity.publicEmail })
              : t("reachPhone", { phone: identity.publicPhone, email: identity.publicEmail })}
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
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-white/38">{t("hoursTitle")}</p>
            <div className="mt-3 space-y-2 text-sm text-white/62">
              <p>{t("hoursWeekdays")}</p>
              <p>{t("hoursClosed")}</p>
            </div>
          </div>
        </aside>
        <div className="border border-white/12 bg-[#11141b]/78 p-6 shadow-[0_24px_90px_rgba(0,0,0,0.38)]">
          {sent ? (
            <div className="py-12 text-center">
              <CheckCircle className="mx-auto mb-5 text-[#a5b4fc]" size={52} />
              <h2 className="text-3xl font-semibold">{t("sentTitle")}</h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-white/60">{t("sentBody")}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <h2 className="text-2xl font-semibold">{t("formTitle")}</h2>
              <Field label={t("fullName")} error={errors.name}><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("fullNamePlaceholder")} /></Field>
              <Field label={t("phoneNumber")} error={errors.phone}><input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t("phonePlaceholder")} /></Field>
              <Field label={t("emailAddress")} error={errors.email}><input className={inputClass} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t("emailPlaceholder")} /></Field>
              <Field label={t("message")} error={errors.message}><textarea className={`${inputClass} min-h-32 resize-none`} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder={t("messagePlaceholder")} /></Field>
              <TurnstileWidget onToken={setTurnstileToken} onError={() => setTurnstileToken(null)} onExpired={() => setTurnstileToken(null)} />
              {errors.submit && <p className="border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{errors.submit}</p>}
              <button disabled={loading || !turnstileToken} className="flex w-full items-center justify-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-bold text-[#11141b] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30">
                {loading ? <Loader2 size={18} className="animate-spin" /> : null}
                {loading ? t("sending") : t("send")}
              </button>
            </form>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20 pt-4">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("faqEyebrow")}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {t("faqHeading")}
        </h2>
        <div className="mt-8">
          <FaqAccordion items={contactFaqs(identity, t)} />
        </div>
      </section>
    </main>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <div><label className="mb-1.5 block text-sm font-semibold text-white/78">{label}</label>{children}{error && <p className="mt-1 text-xs text-red-300">{error}</p>}</div>
}
