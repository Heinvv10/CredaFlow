"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { portalLoginUrl, portalRegisterUrl, portalUrlOrNull } from "@/lib/portal-urls"
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  CheckCircle,
  Loader2,
  ShieldCheck,
  UserCheck,
} from "lucide-react"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { applyLivePricing, applyProductLimitsRands, applyProductTermDays, effectiveApplyTermRange, planApplyTerm, productForAmount, serverTermRangeFromResponse, type ServerTermRange } from "@/lib/public-loan-products"
import { useLivePricing } from "@/lib/use-live-pricing"
import { APPLY_DRAFT_KEY, QUALIFY_DRAFT_KEY, isDraftFresh } from "@/lib/draft-keys"
import { trackApplyStart, trackApplySubmit } from "@/lib/analytics/events"
import {
  createWebsiteSubmissionKey,
  fingerprintWebsiteSubmissionMaterial,
  parseStoredWebsiteSubmissionAttempt,
  WEBSITE_SUBMISSION_ATTEMPT_STORAGE_KEY,
  type WebsiteSubmissionAttempt,
} from "@/lib/applications/website-submission-attempt"
import { useHydrated } from "@/lib/hooks/use-hydrated"
import { useT } from "@/lib/i18n/client"
import { richText } from "@/lib/i18n/rich"
import { applyFaqs } from "./faqs"
import { buildApplyMaterialPayload } from "./payload"

type Step1 = {
  firstName: string
  lastName: string
  idNumber: string
  phone: string
  email: string
}

type Step2 = {
  employmentStatus: string
  employerName: string
  monthlyIncome: string
  monthlyExpenses: string
}

type Step3 = {
  productType: string
  amount: string
  termDays: string
  purpose: string
}

const LAST_ENQUIRY_KEY = "lms:last-enquiry-reference:v1"

// Static fail-open fallback for the apply sliders (MICRO30 R500–R10,000,
// PERSONAL R2,000–R100,000, POFUND R10,000–R500,000). The component overlays the
// LIVE LoanProduct ranges (see liveProductLimits) so an admin range change moves
// the sliders with no code deploy; these figures are used only until the live
// fetch resolves and if it fails.
const productLimits: Record<string, [number, number]> = {
  MICRO: [500, 10000],
  PERSONAL: [2000, 100000],
  PO_FUNDING: [10000, 500000],
}

// Static catalogue for the pre-fetch product routing done in readInitialApplyState
// (a useState initialiser runs before the live fetch resolves). productForAmount
// fails open to exactly these figures. The static short-term/personal maxima
// are a fallback and may differ from a tenant's live LoanProduct ranges, so an
// amount near a boundary can route differently from the live catalogue; the
// live slider bounds + validation then govern. Internal apply links + the qualify result already pass
// an explicit `product`, so this amount-only routing is a fallback path.
const STATIC_APPLY_PRODUCTS = applyLivePricing({})

const stepLabels = ["stepPersonal", "stepEmployment", "stepLoan"] as const

const employmentOptions = [
  { value: "EMPLOYED", label: "employed", body: "employedBody" },
  { value: "SELF_EMPLOYED", label: "selfEmployed", body: "selfEmployedBody" },
  { value: "PENSIONER", label: "pensioner", body: "pensionerBody" },
  { value: "UNEMPLOYED", label: "unemployed", body: "unemployedBody" },
] as const

// `body` (the "R500 - R10,000" range) is rendered from the live bounds, not
// hardcoded, so it tracks the admin's LoanProduct ranges.
const productOptions = [
  { value: "MICRO", label: "productShortTerm", icon: ShieldCheck },
  { value: "PERSONAL", label: "productPersonal", icon: UserCheck },
  { value: "PO_FUNDING", label: "productPo", icon: Briefcase },
] as const

function formatRandRange(min: number, max: number): string {
  return `R${min.toLocaleString()} - R${max.toLocaleString()}`
}

const blankStep1: Step1 = { firstName: "", lastName: "", idNumber: "", phone: "", email: "" }
const blankStep2: Step2 = { employmentStatus: "", employerName: "", monthlyIncome: "", monthlyExpenses: "" }
const blankStep3: Step3 = { productType: "", amount: "", termDays: "", purpose: "" }

function validateSAId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(id[i])
    if (i % 2 === 0) sum += digit
    else {
      const doubled = digit * 2
      sum += doubled > 9 ? doubled - 9 : doubled
    }
  }
  return (10 - (sum % 10)) % 10 === parseInt(id[12])
}

// Amount→product routing via the SHARED tiering helper (Phase 2), so the apply
// form and the qualify wizard can never disagree. Uses the static catalogue here
// because this runs pre-fetch; the live slider bounds + validation govern after.
function productFromAmount(amountRands: number): string {
  return productForAmount(amountRands, STATIC_APPLY_PRODUCTS)
}

// Maps a calculator applyProduct code (or a legacy uppercase product type) to
// the apply form's product type. `capital` (PO funding) previously fell
// through to amount-derived routing and mis-routed PO enquiries into a personal
// loan. `short-term` now shares the MICRO product's R500-R10,000 / 30-day range
// (it mirrors the 30-Day Micro Loan), so it maps straight to MICRO — closing the
// old R2,001-R4,999 straddle where a wider short-term range fell into PERSONAL.
function mapApplyProductCode(value: string | null | undefined): string {
  switch ((value ?? "").toLowerCase()) {
    case "micro":
    case "short-term":
      return "MICRO"
    case "personal":
    case "personal_loan":
      return "PERSONAL"
    case "capital":
    case "purchase-order":
    case "po_funding":
    case "po":
      return "PO_FUNDING"
    // invoice-discounting has no LoanProduct; its CTA routes to an advisor
    // enquiry (see public-loan-products) and does not resolve to a form product.
    default:
      return ""
  }
}

function normaliseAmountParam(value: string | null, unit?: string | null): string {
  if (!value) return ""
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return ""
  // Prefer an explicit unit marker; fall back to the legacy magnitude
  // heuristic for older links (internal links emitted amounts >= 50000 in cents).
  if (unit === "cents") return String(Math.round(raw / 100))
  if (unit === "rands") return String(Math.round(raw))
  return String(raw >= 50000 ? Math.round(raw / 100) : Math.round(raw))
}

function normaliseTermParam(value: string | null): string {
  if (!value) return ""
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return ""
  return String(Math.round(raw))
}

// The qualify v2 draft stores its term CANONICALLY in DAYS, so the apply form reads
// it straight through — no unit conversion, no boundary guess. (v1 drafts used
// display units and are discarded by the key bump.)
function termDaysFromQualifyDraft(term: number | undefined): string {
  if (!term || !Number.isFinite(term) || term <= 0) return ""
  return String(Math.round(term))
}

function clampRands(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function mapEmploymentStatus(value: string): string {
  const key = value.toUpperCase().replace("-", "_")
  return ["EMPLOYED", "SELF_EMPLOYED", "PENSIONER", "UNEMPLOYED"].includes(key) ? key : ""
}

function readAttributionParams() {
  if (typeof window === "undefined") return {}
  const params = new URLSearchParams(window.location.search)
  return {
    source: params.get("source") || undefined,
    referralCode: params.get("ref") || params.get("agent") || undefined,
    utmSource: params.get("utm_source") || undefined,
    utmMedium: params.get("utm_medium") || undefined,
    utmCampaign: params.get("utm_campaign") || undefined,
  }
}

function readInitialApplyState() {
  const initial = {
    step: 1,
    step1: blankStep1,
    step2: blankStep2,
    step3: blankStep3,
    draftRestored: false,
  }

  if (typeof window === "undefined") return initial

  try {
    const params = new URLSearchParams(window.location.search)
    const amountFromUrl = normaliseAmountParam(params.get("amount"), params.get("unit"))
    const termFromUrl = normaliseTermParam(params.get("term"))
    const productFromUrl = mapApplyProductCode(params.get("product"))

    const now = Date.now()

    const applyDraft = window.localStorage.getItem(APPLY_DRAFT_KEY)
    if (applyDraft) {
      const parsed = JSON.parse(applyDraft) as {
        step?: number
        step1?: Partial<Step1>
        step2?: Partial<Step2>
        step3?: Partial<Step3>
        updatedAt?: string
      }
      // POPIA: bounded retention on shared/kiosk devices — a draft older
      // than the TTL is discarded rather than restored (same cleanup idiom
      // as the parse-failure catch branch below).
      if (isDraftFresh(parsed.updatedAt, now)) {
        initial.step1 = { ...initial.step1, ...parsed.step1 }
        initial.step2 = { ...initial.step2, ...parsed.step2 }
        initial.step3 = { ...initial.step3, ...parsed.step3 }
        if (parsed.step && parsed.step >= 1 && parsed.step <= 3) initial.step = parsed.step
        initial.draftRestored = true
      } else {
        window.localStorage.removeItem(APPLY_DRAFT_KEY)
      }
    }

    const qualifyDraft = window.localStorage.getItem(QUALIFY_DRAFT_KEY)
    if (qualifyDraft) {
      const parsed = JSON.parse(qualifyDraft) as {
        stepOne?: { employmentStatus?: string; monthlyIncome?: string; monthlyExpenses?: string }
        stepTwo?: { amount?: number; purpose?: string; term?: number }
        updatedAt?: string
      }
      if (isDraftFresh(parsed.updatedAt, now)) {
        initial.step2 = {
          ...initial.step2,
          employmentStatus: initial.step2.employmentStatus || mapEmploymentStatus(parsed.stepOne?.employmentStatus ?? ""),
          monthlyIncome: initial.step2.monthlyIncome || parsed.stepOne?.monthlyIncome || "",
          monthlyExpenses: initial.step2.monthlyExpenses || parsed.stepOne?.monthlyExpenses || "",
        }
        const amount = parsed.stepTwo?.amount ? String(parsed.stepTwo.amount) : ""
        initial.step3 = {
          ...initial.step3,
          amount: initial.step3.amount || amount,
          productType: initial.step3.productType || productFromAmount(Number(amount)),
          termDays: initial.step3.termDays || termDaysFromQualifyDraft(parsed.stepTwo?.term),
          purpose: initial.step3.purpose || parsed.stepTwo?.purpose || "",
        }
        initial.draftRestored = true
      } else {
        window.localStorage.removeItem(QUALIFY_DRAFT_KEY)
      }
    }

    if (amountFromUrl || productFromUrl) {
      initial.step3 = {
        ...initial.step3,
        amount: amountFromUrl || initial.step3.amount,
        termDays: termFromUrl || initial.step3.termDays,
        productType:
          productFromUrl
            ? productFromUrl
            : amountFromUrl
              ? productFromAmount(Number(amountFromUrl))
              : initial.step3.productType,
      }
      initial.draftRestored = true
    }
  } catch {
    window.localStorage.removeItem(APPLY_DRAFT_KEY)
  }

  return initial
}

export default function ApplyPage() {
  const identity = useWebsiteIdentity()
  const t = useT("websiteApply")
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const submitInFlightRef = useRef(false)
  const submissionAttemptRef = useRef<WebsiteSubmissionAttempt | null>(null)
  const [reference, setReference] = useState<string | null>(null)
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [portalAccountStatus, setPortalAccountStatus] = useState<"ready" | "activation_required" | "unavailable">("unavailable")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverTermRange, setServerTermRange] = useState<ServerTermRange | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  const [consentGiven, setConsentGiven] = useState(false)
  const [step1, setStep1] = useState<Step1>(blankStep1)
  const [step2, setStep2] = useState<Step2>(blankStep2)
  const [step3, setStep3] = useState<Step3>(blankStep3)
  const [draftRestored, setDraftRestored] = useState(false)
  // Restore any saved draft / URL-param prefill AFTER hydration rather than in
  // a useState initializer. readInitialApplyState() reads localStorage and
  // window.location.search, both unavailable during SSR — running it as the
  // initializer meant the server always rendered step 1 with blank fields
  // while the very first client render (hydration) could restore step 2+
  // with populated values, a guaranteed React #418 mismatch. `useHydrated()`
  // is false on the server and during hydration, so the first client render
  // matches the server's blank step 1; the restore then runs once, while
  // rendering, before that render commits. `restored` gates the persistence
  // effect below so it can't clobber a real draft with the blank defaults
  // before this restore runs — same idiom already used in ./qualify/page.tsx.
  const hydrated = useHydrated()
  const [restored, setRestored] = useState(false)
  if (hydrated && !restored) {
    setRestored(true)
    const initial = readInitialApplyState()
    if (initial.draftRestored) {
      setStep(initial.step)
      setStep1(initial.step1)
      setStep2(initial.step2)
      setStep3(initial.step3)
      setDraftRestored(true)
    }
  }

  // Funnel instrumentation (R0-2): fires once when the apply page mounts,
  // independent of the draft-restore path above.
  useEffect(() => {
    trackApplyStart()
  }, [])

  // Live per-product [min,max] (rands) from the shared applyProductLimitsRands
  // helper — the same derivation the tiering rule uses, so the slider bounds and
  // the routing can't disagree. Fail-open: an empty/failed fetch leaves
  // applyLivePricing() = the static catalogue, so these equal the static
  // productLimits until (and unless) the live read returns a different range.
  const { pricing } = useLivePricing()
  const liveProductLimits = useMemo<Record<string, [number, number]>>(
    () => applyProductLimitsRands(applyLivePricing(pricing)) as Record<string, [number, number]>,
    [pricing],
  )
  const liveTermDays = useMemo(() => applyProductTermDays(applyLivePricing(pricing)), [pricing])
  const termRange = (productType: string): { min: number; max: number; fixed: boolean } | undefined =>
    effectiveApplyTermRange(
      productType,
      (liveTermDays as Record<string, { min: number; max: number; fixed: boolean } | undefined>)[productType],
      serverTermRange,
    )
  const termPlan = (productType: string, termDays: string) => planApplyTerm(termDays, termRange(productType))

  useEffect(() => {
    if (!restored) return
    try {
      const hasDraft =
        Object.values(step1).some(Boolean) ||
        Object.values(step2).some(Boolean) ||
        Object.values(step3).some(Boolean)
      if (!hasDraft) return
      window.localStorage.setItem(
        APPLY_DRAFT_KEY,
        JSON.stringify({ step, step1, step2, step3, updatedAt: new Date().toISOString() }),
      )
      window.dispatchEvent(new Event("lms:draft-updated"))
    } catch {
      // Draft persistence is a convenience; submission still works without it.
    }
  }, [step, step1, step2, step3, restored])

  function validateStep1(): boolean {
    const e: Record<string, string> = {}
    if (!step1.firstName.trim()) e.firstName = t("errFirstName")
    if (!step1.lastName.trim()) e.lastName = t("errLastName")
    if (!validateSAId(step1.idNumber)) e.idNumber = t("errIdNumber")
    if (!/^\+?[\d\s-]{10,}$/.test(step1.phone)) e.phone = t("errPhone")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(step1.email)) e.email = t("errEmail")
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function validateStep2(): boolean {
    const e: Record<string, string> = {}
    if (!step2.employmentStatus) e.employmentStatus = t("errEmployment")
    if (!step2.monthlyIncome || Number(step2.monthlyIncome) <= 0) e.monthlyIncome = t("errIncome")
    if (!step2.monthlyExpenses || Number(step2.monthlyExpenses) < 0) e.monthlyExpenses = t("errExpenses")
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function validateStep3(): boolean {
    const e: Record<string, string> = {}
    if (!step3.productType) e.productType = t("errProduct")
    if (!step3.amount || Number(step3.amount) <= 0) e.amount = t("errAmount")
    if (step3.productType && step3.amount) {
      const [min, max] = liveProductLimits[step3.productType] ?? [0, 0]
      const amount = Number(step3.amount)
      if (amount < min || amount > max) {
        e.amount = t("errAmountRange", { min: min.toLocaleString(), max: max.toLocaleString() })
      }
    }
    const termError = termPlan(step3.productType, step3.termDays).error
    if (step3.productType && termError) e.termDays = termError
    if (!step3.purpose.trim()) e.purpose = t("errPurpose")
    if (!consentGiven) e.consent = t("errConsent")
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleNext() {
    setErrors({})
    if (step === 1 && validateStep1()) setStep(2)
    else if (step === 2 && validateStep2()) setStep(3)
  }

  async function handleSubmit() {
    // React state updates do not synchronously disable the button. A ref closes
    // the same-tick window in which two click events can both enter this
    // handler before `loading` is rendered.
    if (submitInFlightRef.current) return
    if (!validateStep3()) return
    if (!turnstileToken) {
      setErrors({ submit: t("errTurnstile") })
      return
    }
    submitInFlightRef.current = true
    setLoading(true)
    const materialPayload = buildApplyMaterialPayload({
      step1,
      step2,
      step3,
      attribution: readAttributionParams(),
      popiaConsent: consentGiven,
      termRange: termRange(step3.productType),
    })
    try {
      const payloadFingerprint = await fingerprintWebsiteSubmissionMaterial(materialPayload)
      if (submissionAttemptRef.current?.fingerprint !== payloadFingerprint) {
        let storedAttempt: WebsiteSubmissionAttempt | null = null
        try {
          storedAttempt = parseStoredWebsiteSubmissionAttempt(
            window.sessionStorage.getItem(WEBSITE_SUBMISSION_ATTEMPT_STORAGE_KEY),
          )
        } catch {
          // Storage can be unavailable in hardened/private browser contexts.
          // The in-memory attempt still protects same-page retries.
        }
        submissionAttemptRef.current =
          storedAttempt?.fingerprint === payloadFingerprint
            ? storedAttempt
            : {
                fingerprint: payloadFingerprint,
                key: createWebsiteSubmissionKey(),
              }
        try {
          window.sessionStorage.setItem(
            WEBSITE_SUBMISSION_ATTEMPT_STORAGE_KEY,
            JSON.stringify(submissionAttemptRef.current),
          )
        } catch {
          // Same-page retry protection remains available through the ref.
        }
      }
      const submissionKey = submissionAttemptRef.current.key
      const res = await fetch("/api/website/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...materialPayload, turnstileToken, submissionKey }),
      })
      const data = await res.json()
      if (data.success) {
        // Establish the observed server result before any best-effort browser
        // persistence. localStorage can throw in hardened/private/quota-limited
        // contexts; that must not turn a committed 200 into a displayed network
        // failure or discard the key needed to replay it.
        setPortalAccountStatus(data.portalAccountStatus ?? "unavailable")
        setApplicationId(data.applicationId ?? null)
        setReference(data.reference)
        try {
          trackApplySubmit()
        } catch {
          // Analytics is non-authoritative and must not change the result.
        }
        try {
          window.localStorage.removeItem(APPLY_DRAFT_KEY)
          window.localStorage.removeItem(QUALIFY_DRAFT_KEY)
          window.localStorage.setItem(
            LAST_ENQUIRY_KEY,
            JSON.stringify({
              reference: data.reference,
              applicationId: data.applicationId ?? null,
              productType: step3.productType,
              amount: step3.amount,
              termDays: termPlan(step3.productType, step3.termDays).sendTermDays,
              updatedAt: new Date().toISOString(),
            }),
          )
        } catch {
          // The success screen remains authoritative without browser storage.
        }
        submissionAttemptRef.current = null
        try {
          window.sessionStorage.removeItem(WEBSITE_SUBMISSION_ATTEMPT_STORAGE_KEY)
        } catch {
          // The success screen has no submit action; stale storage is harmless
          // and will be replaced when the material payload changes.
        }
      } else {
        // Turnstile tokens are single-use once the server verifies them. Reset
        // after every unsuccessful response: some business failures happen
        // after verification, and reusing that token would force a guaranteed
        // extra failed retry before the widget refreshed.
        setTurnstileToken(null)
        setTurnstileResetKey((key) => key + 1)
        const guidedRange = res.status === 400 ? serverTermRangeFromResponse(step3.productType, data) : null
        if (guidedRange) {
          // Show the term field with the server's range, next to the message.
          setServerTermRange(guidedRange)
          setErrors({ termDays: data.error })
        } else {
          setErrors({ submit: data.error ?? t("errGeneric") })
        }
      }
    } catch {
      // The request may have committed even though its response was lost.
      // Keep the same submission attempt/key, but obtain a fresh single-use
      // Turnstile token before replaying it.
      setTurnstileToken(null)
      setTurnstileResetKey((key) => key + 1)
      setErrors({ submit: t("errNetwork") })
    } finally {
      submitInFlightRef.current = false
      setLoading(false)
    }
  }

  function chooseProduct(value: string) {
    const [min, max] = liveProductLimits[value] ?? productLimits[value]
    const amount = step3.amount ? clampRands(Number(step3.amount), min, max) : min
    setStep3({ ...step3, productType: value, amount: String(amount) })
  }

  if (reference) {
    // Portal URLs come from lib/portal-urls.ts, which honours the same
    // NEXT_PUBLIC_PORTAL_LOGIN_URL override NavBar + the homepage login CTA use
    // — one source of truth for the on-page links and the email CTA.
    // Null when no portal URL is configured: the buttons are left out rather
    // than crashing the success screen after the application was created.
    const portalRegisterHref = portalUrlOrNull(() => portalRegisterUrl(step1.email, reference))
    const portalLoginHref = portalUrlOrNull(() => portalLoginUrl())
    // Portal CTA gating: only offer "Create portal account" when a client row
    // exists without a password yet (activation_required). When the status is
    // "unavailable" (identity conflict / no client row) /portal/register 404s,
    // so offer neither register nor login. "Track your application" copy
    // only shows when an application was actually created.
    const canRegister = portalAccountStatus === "activation_required"
    const canLogin = portalAccountStatus === "ready"
    const hasPortalAccount = canRegister || canLogin

    return (
      <main className="relative min-h-screen overflow-hidden bg-[#11141b] px-4 py-20 text-white">
        <div className="absolute inset-0 bg-[#11141b]/50" />
        <div className="absolute inset-0 bg-linear-to-b from-[#11141b]/42 via-[#11141b]/28 to-[#11141b]" />
        <div className="relative mx-auto max-w-xl border border-[#a5b4fc]/35 bg-white/[0.045] p-8 text-center shadow-[0_24px_90px_rgba(0,0,0,0.4)] backdrop-blur-xl">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center border border-[#a5b4fc]/45 bg-[#a5b4fc]/12 text-[#a5b4fc]">
            <CheckCircle size={40} />
          </div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("receivedEyebrow")}</p>
          <h2 className="mb-3 text-3xl font-semibold text-white">{step1.firstName ? t("thankYou", { name: step1.firstName }) : t("thankYouNoName")}</h2>
          <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-white/62">
            {t("receivedBody")}
          </p>
          <div className="mb-6 border border-white/10 bg-black/18 p-5">
            <p className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-white/38">{t("referenceNumber")}</p>
            <p className="text-2xl font-bold text-[#a5b4fc]">{reference}</p>
          </div>
          {applicationId && (
            <p className="text-sm text-white/50">
              {richText(t("confirmationTo", { email: step1.email }), { b: (chunk) => <strong>{chunk}</strong> })}
            </p>
          )}

          {hasPortalAccount ? (
            <div className="mt-7 border border-[#a5b4fc]/25 bg-[#a5b4fc]/8 p-5 text-left">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#a5b4fc]">
                {applicationId ? t("trackEyebrow") : t("portalEyebrow")}
              </p>
              <h3 className="mt-2 text-lg font-semibold text-white">
                {applicationId
                  ? t("trackHeading")
                  : canLogin
                    ? t("loginHeading")
                    : t("registerHeading")}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/58">
                {canLogin ? t("loginBody") : t("registerBody")}
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {canRegister && portalRegisterHref && (
                  <Link
                    href={portalRegisterHref}
                    className="inline-flex items-center justify-center bg-[#a5b4fc] px-4 py-3 text-sm font-bold text-[#11141b] transition hover:bg-[#c7d2fe]"
                  >
                    {t("createPortal")}
                  </Link>
                )}
                {portalLoginHref && (
                  <Link
                    href={portalLoginHref}
                    className="inline-flex items-center justify-center border border-white/15 px-4 py-3 text-sm font-bold text-white transition hover:border-[#a5b4fc]/45 hover:text-[#a5b4fc]"
                  >
                    {t("loginPortal")}
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-7 border border-white/12 bg-black/18 p-5 text-left">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#a5b4fc]">{t("nextEyebrow")}</p>
              <h3 className="mt-2 text-lg font-semibold text-white">{t("nextHeading")}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/58">
                {t("nextBody")}
              </p>
            </div>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#11141b] text-white">
      <section className="relative overflow-hidden px-4 py-10 text-center md:py-12">
        <div className="absolute inset-0 bg-[#11141b]/50" />
        <div className="absolute inset-0 bg-linear-to-b from-[#11141b]/42 via-[#11141b]/28 to-[#11141b]" />
        <div className="relative mx-auto max-w-3xl">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("eyebrow")}</p>
          <h1 className="text-balance text-4xl font-semibold text-white md:text-5xl">{t("title")}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/62">
            {t("intro")}
          </p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 pb-14 lg:grid-cols-[0.8fr_1.2fr]">
        <aside className="border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("pathEyebrow")}</p>
          <h2 className="mt-3 text-2xl font-semibold text-white">{t("pathHeading")}</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/58">
            {t("pathBody", { brand: identity.tradingName })}
          </p>
          <div className="mt-6 space-y-3">
            {stepLabels.map((label, i) => (
              <div key={label} className={`border px-4 py-3 ${i + 1 === step ? "border-[#a5b4fc]/45 bg-[#a5b4fc]/10" : "border-white/8 bg-black/16"}`}>
                <div className="flex items-center gap-3">
                  <span className={`flex h-8 w-8 items-center justify-center text-xs font-bold ${i + 1 <= step ? "bg-[#a5b4fc] text-[#11141b]" : "bg-white/[0.06] text-white/42"}`}>
                    {i + 1 < step ? <CheckCircle size={16} /> : i + 1}
                  </span>
                  <span className={i + 1 === step ? "font-semibold text-white" : "font-semibold text-white/54"}>{t(label)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 border border-white/8 bg-black/18 p-4 text-xs leading-relaxed text-white/46">
            POPIA consent, affordability assessment and credit checks are required before final approval. {identity.legalName} is a registered credit provider (NCR Reg: {identity.ncrNumber}).
          </div>
        </aside>

        <div className="border border-white/12 bg-[#11141b]/78 p-5 shadow-[0_24px_90px_rgba(0,0,0,0.38)] backdrop-blur-xl md:p-7">
          {draftRestored && (
            <div className="mb-5 border border-[#a5b4fc]/35 bg-[#a5b4fc]/10 px-4 py-3 text-sm text-[#a5b4fc]">
              {t("draftRestored")}
            </div>
          )}
          <h2 className="mb-6 text-xl font-semibold text-white">{t("stepOf", { step, label: t(stepLabels[step - 1]) })}</h2>

          {step === 1 && (
            <div className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t("firstName")} error={errors.firstName}>
                  <input className={inputClass} value={step1.firstName} onChange={(e) => setStep1({ ...step1, firstName: e.target.value })} placeholder={t("firstNamePlaceholder")} />
                </Field>
                <Field label={t("lastName")} error={errors.lastName}>
                  <input className={inputClass} value={step1.lastName} onChange={(e) => setStep1({ ...step1, lastName: e.target.value })} placeholder={t("lastNamePlaceholder")} />
                </Field>
              </div>
              <Field label={t("idNumber")} error={errors.idNumber}>
                <input className={inputClass} value={step1.idNumber} onChange={(e) => setStep1({ ...step1, idNumber: e.target.value })} placeholder={t("idPlaceholder")} maxLength={13} />
              </Field>
              <Field label={t("phone")} error={errors.phone}>
                <input className={inputClass} type="tel" value={step1.phone} onChange={(e) => setStep1({ ...step1, phone: e.target.value })} placeholder={t("phonePlaceholder")} />
              </Field>
              <Field label={t("email")} error={errors.email}>
                <input className={inputClass} type="email" value={step1.email} onChange={(e) => setStep1({ ...step1, email: e.target.value })} placeholder={t("emailPlaceholder")} />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-sm font-semibold text-white/78">{t("employmentStatus")}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {employmentOptions.map((option) => (
                    <ChoiceButton key={option.value} active={step2.employmentStatus === option.value} title={t(option.label)} body={t(option.body)} onClick={() => setStep2({ ...step2, employmentStatus: option.value })} />
                  ))}
                </div>
                {errors.employmentStatus && <p className="mt-1 text-xs text-red-300">{errors.employmentStatus}</p>}
              </div>
              <Field label={t("employer")}>
                <input className={inputClass} value={step2.employerName} onChange={(e) => setStep2({ ...step2, employerName: e.target.value })} placeholder={t("employerPlaceholder")} />
              </Field>
              <Field label={t("netIncome")} error={errors.monthlyIncome}>
                <input className={inputClass} type="number" min={0} value={step2.monthlyIncome} onChange={(e) => setStep2({ ...step2, monthlyIncome: e.target.value })} placeholder={t("netIncomePlaceholder")} />
              </Field>
              <Field label={t("expenses")} error={errors.monthlyExpenses}>
                <input className={inputClass} type="number" min={0} value={step2.monthlyExpenses} onChange={(e) => setStep2({ ...step2, monthlyExpenses: e.target.value })} placeholder={t("expensesPlaceholder")} />
              </Field>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-sm font-semibold text-white/78">{t("loanProduct")}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {productOptions.map(({ value, label, icon: Icon }) => {
                    const [min, max] = liveProductLimits[value] ?? productLimits[value]
                    return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => chooseProduct(value)}
                      className={`border p-4 text-left transition-colors ${
                        step3.productType === value
                          ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
                          : "border-white/12 bg-white/[0.04] text-white/62 hover:border-white/22 hover:text-white"
                      }`}
                    >
                      <Icon size={19} className="mb-3" />
                      <span className="block text-sm font-bold">{t(label)}</span>
                      <span className="mt-1 block text-xs opacity-75">{formatRandRange(min, max)}</span>
                    </button>
                    )
                  })}
                </div>
                {errors.productType && <p className="mt-1 text-xs text-red-300">{errors.productType}</p>}
              </div>
              {step3.productType && (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-white/78">
                    {t("loanAmount", { amount: Number(step3.amount || 0).toLocaleString() })}
                  </label>
                  <input
                    className={`${inputClass} mb-3`}
                    type="number"
                    min={liveProductLimits[step3.productType]?.[0] ?? 500}
                    max={liveProductLimits[step3.productType]?.[1] ?? 2000}
                    step={step3.productType === "MICRO" ? 100 : 1000}
                    value={step3.amount || liveProductLimits[step3.productType]?.[0]}
                    onChange={(e) => setStep3({ ...step3, amount: e.target.value })}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      const [min, max] = liveProductLimits[step3.productType] ?? [500, 2000]
                      setStep3({ ...step3, amount: String(clampRands(Number(e.target.value), min, max)) })
                    }}
                    inputMode="numeric"
                  />
                  <input
                    type="range"
                    min={liveProductLimits[step3.productType]?.[0] ?? 500}
                    max={liveProductLimits[step3.productType]?.[1] ?? 2000}
                    step={step3.productType === "MICRO" ? 100 : 1000}
                    value={clampRands(
                      Number(step3.amount || liveProductLimits[step3.productType]?.[0]),
                      liveProductLimits[step3.productType]?.[0] ?? 500,
                      liveProductLimits[step3.productType]?.[1] ?? 2000,
                    )}
                    onChange={(e) => setStep3({ ...step3, amount: e.target.value })}
                    className="w-full accent-[#a5b4fc]"
                  />
                  <div className="mt-1 flex justify-between text-xs text-white/40">
                    <span>R{(liveProductLimits[step3.productType]?.[0] ?? 500).toLocaleString()}</span>
                    <span>R{(liveProductLimits[step3.productType]?.[1] ?? 2000).toLocaleString()}</span>
                  </div>
                  {errors.amount && <p className="mt-1 text-xs text-red-300">{errors.amount}</p>}
                </div>
              )}
              {step3.productType && termPlan(step3.productType, step3.termDays).showField && (
                <Field label={t("loanTerm")} error={errors.termDays}>
                  <input
                    className={inputClass}
                    type="number"
                    inputMode="numeric"
                    min={termRange(step3.productType)?.min ?? 1}
                    max={termRange(step3.productType)?.max}
                    step={1}
                    value={step3.termDays}
                    onChange={(e) => setStep3({ ...step3, termDays: e.target.value })}
                    placeholder={
                      termRange(step3.productType)
                        ? t("termRangePlaceholder", { min: termRange(step3.productType)?.min ?? "", max: termRange(step3.productType)?.max ?? "" })
                        : t("termPlaceholder")
                    }
                  />
                </Field>
              )}
              <Field label={t("purpose")} error={errors.purpose}>
                <textarea className={`${inputClass} min-h-24 resize-none`} value={step3.purpose} onChange={(e) => setStep3({ ...step3, purpose: e.target.value })} placeholder={t("purposePlaceholder")} />
              </Field>
              <TurnstileWidget key={turnstileResetKey} onToken={setTurnstileToken} onError={() => setTurnstileToken(null)} onExpired={() => setTurnstileToken(null)} />
              {errors.submit && <p className="border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{errors.submit}</p>}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentGiven}
                  onChange={(e) => setConsentGiven(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#a5b4fc]"
                />
                <span className="text-xs leading-relaxed text-white/62">
                  I consent to {identity.legalName} (NCR Reg: {identity.ncrNumber}) processing my personal information in terms of POPIA and conducting a credit bureau enquiry to assess this application.
                </span>
              </label>
              {errors.consent && <p className="-mt-1 text-xs text-red-300">{errors.consent}</p>}
            </div>
          )}

          <div className="mt-8 flex justify-between border-t border-white/10 pt-6">
            {step > 1 ? (
              <button onClick={() => { setErrors({}); setStep(step - 1) }} className="flex items-center gap-2 border border-white/18 px-5 py-2.5 text-sm font-semibold text-white/72 transition-colors hover:bg-white/[0.05] hover:text-white">
                <ArrowLeft size={16} />
                {t("back")}
              </button>
            ) : <div />}
            {step < 3 ? (
              <button onClick={handleNext} className="flex items-center gap-2 bg-[#a5b4fc] px-6 py-2.5 text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe]">
                {t("continue")}
                <ArrowRight size={16} />
              </button>
            ) : (
              <button onClick={handleSubmit} disabled={loading || !turnstileToken || !consentGiven} className="flex items-center gap-2 bg-[#a5b4fc] px-6 py-2.5 text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe] disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/30">
                {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                {loading ? t("submitting") : t("submit")}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20 pt-4">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("faqEyebrow")}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {t("faqHeading")}
        </h2>
        <div className="mt-8">
          <FaqAccordion items={applyFaqs(t)} />
        </div>
      </section>
    </main>
  )
}

const inputClass =
  "w-full border border-white/12 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-white/28 focus:border-[#a5b4fc] focus:outline-none focus:ring-2 focus:ring-[#a5b4fc]/15"

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-semibold text-white/78">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  )
}

function ChoiceButton({
  active,
  title,
  body,
  onClick,
}: {
  active: boolean
  title: string
  body: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-4 py-3 text-left transition-colors ${
        active
          ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
          : "border-white/12 bg-white/[0.04] text-white/62 hover:border-white/22 hover:text-white"
      }`}
    >
      <span className="block text-sm font-bold">{title}</span>
      <span className="mt-1 block text-xs opacity-75">{body}</span>
    </button>
  )
}
