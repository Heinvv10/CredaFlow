"use client"

import { useEffect, useMemo, useState } from "react"
import { Shield } from "lucide-react"
import QualifyStepOne from "./QualifyStepOne"
import QualifyStepTwo from "./QualifyStepTwo"
import QualifyResult from "./QualifyResult"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { applyLivePricing } from "@/lib/public-loan-products"
import { useLivePricing } from "@/lib/use-live-pricing"
import { QUALIFY_DRAFT_KEY } from "@/lib/draft-keys"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { qualifyFaqs, QUALIFY_FAQ_GROUPS } from "./faqs"

const STEP_LABELS = ["Income", "Loan Details", "Result"]

type StepOne = {
  employmentStatus: string
  monthlyIncome: string
  monthlyExpenses: string
}

type StepTwo = {
  amount: number
  purpose: string
  term: number
}

const DEFAULT_STEP_ONE: StepOne = {
  employmentStatus: "",
  monthlyIncome: "",
  monthlyExpenses: "",
}

const DEFAULT_STEP_TWO: StepTwo = {
  amount: 5000,
  purpose: "",
  // term is CANONICAL DAYS. 7 = the shortest micro term (7 days) — the pre-check must
  // not look easier by silently spreading repayment. If the live range makes R5,000
  // personal, QualifyStepTwo re-displays 7 days as round(7/30)=0 → clamped to the
  // 3-month minimum, so the default reconciles cleanly (no unit ambiguity).
  term: 7,
}

function readQualifyDraft(): { stepOne: StepOne; stepTwo: StepTwo } {
  if (typeof window === "undefined") {
    return { stepOne: DEFAULT_STEP_ONE, stepTwo: DEFAULT_STEP_TWO }
  }

  try {
    const raw = window.localStorage.getItem(QUALIFY_DRAFT_KEY)
    if (!raw) return { stepOne: DEFAULT_STEP_ONE, stepTwo: DEFAULT_STEP_TWO }
    const draft = JSON.parse(raw) as { stepOne?: Partial<StepOne>; stepTwo?: Partial<StepTwo> }
    return {
      stepOne: { ...DEFAULT_STEP_ONE, ...draft.stepOne },
      stepTwo: { ...DEFAULT_STEP_TWO, ...draft.stepTwo },
    }
  } catch {
    window.localStorage.removeItem(QUALIFY_DRAFT_KEY)
    return { stepOne: DEFAULT_STEP_ONE, stepTwo: DEFAULT_STEP_TWO }
  }
}

export default function QualifyPage() {
  const identity = useWebsiteIdentity()
  const [step, setStep] = useState(0)
  const [stepOne, setStepOne] = useState(DEFAULT_STEP_ONE)
  const [stepTwo, setStepTwo] = useState(DEFAULT_STEP_TWO)
  // Restore any saved draft AFTER mount to avoid a server/client hydration
  // mismatch. `hydrated` gates the persistence effect below so it can't
  // clobber a saved draft with the defaults before the restore runs.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    const draft = readQualifyDraft()
    // One-time client-only draft restore after mount — the standard way to read
    // localStorage without a server/client hydration mismatch.
    /* eslint-disable react-hooks/set-state-in-effect */
    setStepOne(draft.stepOne)
    setStepTwo(draft.stepTwo)
    setHydrated(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  // Live LoanProduct ranges + fee structure, shared with the calculator + apply
  // form. Overlaid onto the static catalogue (fail-open to static on empty/error)
  // and passed to both wizard steps so their bounds, term unit and pricing track
  // whatever the admin configured — no code deploy needed.
  const { pricing } = useLivePricing()
  const products = useMemo(() => applyLivePricing(pricing), [pricing])

  const incomeCents = Math.round(Number(stepOne.monthlyIncome) * 100)
  const expensesCents = Math.round(Number(stepOne.monthlyExpenses) * 100)

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(
        QUALIFY_DRAFT_KEY,
        JSON.stringify({
          stepOne,
          stepTwo,
          updatedAt: new Date().toISOString(),
        }),
      )
      window.dispatchEvent(new Event("lms:draft-updated"))
    } catch {
      // Local storage can be unavailable in private browsing; the form still works.
    }
  }, [stepOne, stepTwo, hydrated])

  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <section className="relative overflow-hidden px-4 py-8 text-center md:py-9">
        <div className="absolute inset-0 bg-[#11141b]/50" />
        <div className="absolute inset-0 bg-linear-to-b from-[#11141b]/42 via-[#11141b]/28 to-[#11141b]" />
        <div className="relative mx-auto max-w-2xl">
          <Shield className="mx-auto mb-3 text-[#a5b4fc]" size={34} strokeWidth={1.8} />
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.28em] text-[#a5b4fc]">
            Eligibility check
          </p>
          <h1 className="mb-2 text-balance text-3xl font-semibold text-white md:text-4xl">
            Check if You Qualify
          </h1>
          <p className="mx-auto max-w-lg text-sm leading-relaxed text-white/62">
            Answer a few guided questions to receive an instant pre-qualification estimate. No credit check required.
          </p>
        </div>
      </section>

      <section aria-labelledby="qualify-form-heading">
      <div className="mx-auto max-w-2xl px-4 pt-8 text-center">
        <h2 id="qualify-form-heading" className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Start your eligibility check
        </h2>
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-5 pb-2">
        <div className="flex items-center justify-between">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2 last:flex-none">
              <div
                className={`flex h-8 w-8 items-center justify-center border text-xs font-bold ${
                  i <= step
                    ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
                    : "border-white/12 bg-white/[0.04] text-white/38"
                }`}
              >
                {i + 1}
              </div>
              <span
                className={`hidden text-xs font-semibold sm:inline ${
                  i <= step ? "text-[#a5b4fc]" : "text-white/38"
                }`}
              >
                {label}
              </span>
              {i < STEP_LABELS.length - 1 && (
                <div
                  className={`mx-2 h-px flex-1 ${i < step ? "bg-[#a5b4fc]" : "bg-white/12"}`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 pb-14">
        <div className="border border-white/12 bg-[#11141b]/78 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.38)] backdrop-blur-xl md:p-5">
          {step === 0 && (
            <QualifyStepOne
              data={stepOne}
              onChange={setStepOne}
              onNext={() => setStep(1)}
            />
          )}
          {step === 1 && (
            <QualifyStepTwo
              data={stepTwo}
              onChange={setStepTwo}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
              products={products}
            />
          )}
          {step === 2 && (
            <QualifyResult
              incomeCents={incomeCents}
              expensesCents={expensesCents}
              amountRands={stepTwo.amount}
              termValue={stepTwo.term}
              products={products}
              onRestart={() => {
                setStep(0)
                setStepOne(DEFAULT_STEP_ONE)
                setStepTwo(DEFAULT_STEP_TWO)
              }}
            />
          )}
        </div>
      </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20 pt-4">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">Eligibility FAQ</p>
        <div className="mt-8">
          <FaqAccordion
            groups={QUALIFY_FAQ_GROUPS.map((heading) => ({
              heading,
              items: qualifyFaqs(identity).filter((faq) => faq.group === heading),
            }))}
          />
        </div>
      </section>
    </main>
  )
}
