"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { StepBar } from "@/components/wizard/StepBar"
import type { Client } from "@/components/wizard/types"
import { useHydrated } from "@/lib/hooks/use-hydrated"
import { sessionWizardStore } from "@/lib/wizard/session-storage"
import {
  validateStep1ClientSelect,
  validateStep2LoanParams,
  validateStep3Affordability,
  validateStep4Review,
  type ValidationErrors,
} from "@/lib/validation/application-wizard"
import {
  APPLICATION_WIZARD_STEP_LABELS,
  EMPTY_APPLICATION_WIZARD_DATA,
  type ApplicationProduct,
  type ApplicationWizardData,
  type ApplicationWizardStep,
  type WizardMode,
} from "./types"
import { APPLICATION_WIZARD_STORAGE_KEY } from "./constants"
import { buildStepUrl } from "./step-url"
import { Step1ClientSelect } from "./Step1ClientSelect"
import { useOwnLenderDebts } from "./useOwnLenderDebts"
import { Step2LoanParams } from "./Step2LoanParams"
import { Step3Affordability } from "./Step3Affordability"
import { Step4Review } from "./Step4Review"
import type { ClientForAffordability } from "./Step3Affordability"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  creditLifePrincipalIsEligible,
  type CreditLifePresentedOffer,
} from "@/lib/insurance/credit-life-election"

/** Client shape required by the wizard. The page is responsible for
 *  selecting `monthlyIncome`, `monthlyExpenses`, and `debtObligations`
 *  from the Prisma row and coercing Decimal/string to number. */
export type ClientWithFinancials = Client & ClientForAffordability

interface Props {
  mode: WizardMode
  clients: ClientWithFinancials[]
  products: ApplicationProduct[]
  // Set when resuming an existing DRAFT application (loaded server-side from
  // ?id=). When present, `initialData` seeds the wizard instead of the
  // sessionStorage draft, and submit PATCHes the existing row instead of
  // POSTing a new one.
  applicationId?: string
  initialData?: ApplicationWizardData
  creditLifeOffer: CreditLifePresentedOffer | null
}

export function ApplicationWizard({ mode, clients, products, applicationId, initialData, creditLifeOffer }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const store = useMemo(
    () => sessionWizardStore<ApplicationWizardData>(APPLICATION_WIZARD_STORAGE_KEY),
    [],
  )

  const [data, setData] = useState<ApplicationWizardData>(initialData ?? EMPTY_APPLICATION_WIZARD_DATA)
  // Captured once from the initial `applicationId` prop and never updated.
  // The wizard writes `id` into every step-URL change (see goTo/buildStepUrl
  // below), but if a stray navigation (e.g. a stale cached page, or manual
  // URL edit) ever drops it, this state — not the prop — decides whether
  // submit PATCHes the existing draft or POSTs a new one. Belt and braces
  // against the duplicate-draft bug this resume-mode feature was built to
  // fix.
  const [appId] = useState(applicationId)
  const [step, setStep] = useState<ApplicationWizardStep>(1)
  const [errors, setErrors] = useState<ValidationErrors<ApplicationWizardData>>({})
  const [editingFromReview, setEditingFromReview] = useState(false)
  // null when no submit is in flight. "draft" or "review" identifies which
  // button kicked off the current request so each button can show its own
  // in-flight label without the other one borrowing it.
  const [submittingAs, setSubmittingAs] = useState<"draft" | "review" | null>(null)
  const submitting = submittingAs !== null
  const [submitError, setSubmitError] = useState<string | null>(null)

  // sessionStorage and the URL step are browser-only, so restore them once
  // after hydration, while rendering (before that render commits): the server
  // and the first client render both show the blank/initialData wizard on step 1.
  const hydrated = useHydrated()
  const [restored, setRestored] = useState(false)
  if (hydrated && !restored) {
    setRestored(true)
    // Resuming an existing application: server-loaded `initialData` wins —
    // never let a stale sessionStorage draft (from an unrelated in-progress
    // "New Application") clobber it.
    if (!appId) {
      // Merge over the empty shape rather than replacing it: a draft written by
      // an older bundle predates any field added since, and those keys would
      // otherwise be `undefined` at runtime despite their non-optional types.
      const saved = store.load()
      if (saved) setData({ ...EMPTY_APPLICATION_WIZARD_DATA, ...saved })
    }
    setStep(clampStep(Number(searchParams.get("step") ?? "1")))
  }

  // Sync state.step when the URL changes (browser back/forward). Adjusted while
  // rendering, on the identity of `searchParams` (new object per navigation).
  const [prevSearchParams, setPrevSearchParams] = useState(searchParams)
  if (searchParams !== prevSearchParams) {
    setPrevSearchParams(searchParams)
    const urlStep = clampStep(Number(searchParams.get("step") ?? "1"))
    if (urlStep !== step) {
      setStep(urlStep)
      setEditingFromReview(false)
      setErrors({})
    }
  }

  useEffect(() => {
    // Don't let a resumed application's edits overwrite the shared
    // sessionStorage draft key — that key belongs to the blank "New
    // Application" flow and must not pick up an unrelated saved row's data.
    if (restored && !appId) store.save(data)
  }, [data, store, appId, restored])

  const patch = (partial: Partial<ApplicationWizardData>) =>
    setData((d) => ({ ...d, ...partial }))

  function goTo(n: ApplicationWizardStep, opts: { fromReview?: boolean } = {}) {
    setStep(n)
    setEditingFromReview(opts.fromReview ?? false)
    setErrors({})
    router.replace(buildStepUrl(searchParams.toString(), n))
  }

  function handleBack() {
    if (step <= 1) return
    goTo((step - 1) as ApplicationWizardStep)
  }

  function handleNext() {
    const stepErrs = validateCurrentStep(step, data, products)
    if (Object.keys(stepErrs).length > 0) {
      setErrors(stepErrs)
      return
    }
    const next: ApplicationWizardStep = editingFromReview
      ? 4
      : ((step + 1) as ApplicationWizardStep)
    goTo(next)
  }

  async function handleSubmit(asDraft: boolean) {
    setSubmittingAs(asDraft ? "draft" : "review")
    setSubmitError(null)
    try {
      // Wizard collects amount in rands (string, up to 2 decimals); convert
      // to cents at the wire boundary. See lib/loan-calculator.ts which
      // operates in cents end-to-end.
      const payload = {
        ...(appId && { action: "update" as const }),
        ...data,
        appliedAmount: Math.round(Number(data.appliedAmount) * 100),
        appliedTermDays: Number(data.appliedTermDays),
        submitForReview: !asDraft,
        ...(creditLifeOffer && {
          creditLifeProductId: creditLifeOffer.productId,
          creditLifeProductName: creditLifeOffer.productName,
          creditLifeInsurerId: creditLifeOffer.insurerId,
          creditLifeInsurerName: creditLifeOffer.insurerName,
          creditLifeMonthlyPremiumCents: calculateCreditLifeMonthlyPremiumCents(
            Math.round(Number(data.appliedAmount) * 100),
          ),
          creditLifeDisclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        }),
        // Save-as-draft path zeros the Step-4 ack booleans (PASQ + §81) so
        // an audit column on the row implies the corresponding boolean was
        // true at submit-for-review time. recklessLendingConfirmed stays as
        // captured: it is a Step-3 navigation gate (validateStep3Affordability
        // requires it true to advance off Step 3 on FAIL), and the API's
        // audit-write spread is already gated on `isSubmitting`, so the
        // draft path never persists recklessLendingAssessed regardless.
        ...(asDraft && {
          pasqAcknowledged: false,
          affordabilityDeclared: false,
          creditLifeDisclosureAcknowledged: false,
        }),
      }
      const res = await fetch(
        appId ? `/api/applications/${appId}` : "/api/applications",
        {
          method: appId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        const body = (await res.json()) as {
          error?: string
          errors?: ValidationErrors<ApplicationWizardData>
        }
        if (body.errors && Object.keys(body.errors).length > 0) {
          setErrors(body.errors)
          goTo(earliestStepWithErrors(body.errors))
          throw new Error(body.error ?? "Validation failed")
        }
        throw new Error(body.error ?? "Failed to save application")
      }
      store.clear()
      toast.success(asDraft ? "Draft saved" : "Application submitted for review")
      router.push("/applications")
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An error occurred"
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setSubmittingAs(null)
    }
  }

  // Submit-for-review is disabled until all required acks are checked.
  // Mirrors the legacy `canSubmit` gate. Save-as-draft is enabled whenever
  // Steps 1–3 are valid (validation happens server-side; here we only
  // gate the button label so staff get a clear visual cue).
  // With no configured credit-life product there is no cover to offer, so there
  // is no election to make and nothing for the client to acknowledge. The
  // server records the no-offer disclosure at submit. Requiring an offer here
  // is what made EVERY application unsubmittable while none was configured.
  const creditLifeReady =
    creditLifeOffer === null
    || (
      data.creditLifeDisclosureAcknowledged
      && (
        data.creditLifeElection === "DECLINED"
        || (
          data.creditLifeElection === "ACCEPTED"
          && creditLifeOffer.autoBundleEnabled
          && creditLifePrincipalIsEligible(Math.round(Number(data.appliedAmount) * 100))
        )
      )
    )

  const canSubmitForReview =
    data.pasqAcknowledged &&
    creditLifeReady &&
    data.affordabilityDeclared &&
    (data.affordabilityFlag !== "FAIL" || data.recklessLendingConfirmed)

  // Stable identity for the Step 3 useEffect dep array. Without useMemo, a
  // fresh object literal on every wizard render → effect re-fires → patch →
  // re-render → "Maximum update depth exceeded".
  const declaredClient = useMemo(() => {
    const c = clients.find((c) => c.id === data.clientId)
    return c
      ? {
          monthlyIncome: c.monthlyIncome,
          monthlyExpenses: c.monthlyExpenses,
          debtObligations: c.debtObligations,
        }
      : null
  }, [clients, data.clientId])
  const selectedClientForStep3 = useOwnLenderDebts(declaredClient, data.clientId) // + obligations to this lender

  return (
    <div className="max-w-3xl mx-auto p-6">
      <StepBar step={step} labels={APPLICATION_WIZARD_STEP_LABELS} />

      {step === 1 && (
        <Step1ClientSelect data={data} patch={patch} errors={errors} mode={mode} clients={clients} selectedClientArrears={selectedClientForStep3?.ownLenderArrears} />
      )}
      {step === 2 && (
        <Step2LoanParams data={data} patch={patch} errors={errors} mode={mode} products={products} />
      )}
      {step === 3 && (
        <Step3Affordability
          data={data}
          patch={patch}
          errors={errors}
          mode={mode}
          products={products}
          selectedClient={selectedClientForStep3}
        />
      )}
      {step === 4 && (
        <Step4Review
          data={data}
          patch={patch}
          errors={errors}
          mode={mode}
          editJump={(n) => goTo(n, { fromReview: true })}
          clients={clients}
          products={products}
          creditLifeOffer={creditLifeOffer}
        />
      )}

      {submitError && (
        <div className="mt-4 rounded-lg border border-[var(--cf-danger)]/30 bg-[var(--cf-danger)]/10 p-3 text-sm text-[var(--cf-danger)]">
          {submitError}
        </div>
      )}

      <footer className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
        <button
          type="button"
          onClick={handleBack}
          disabled={step <= 1}
          className="px-4 py-2 text-sm rounded-lg border border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] disabled:opacity-40 self-start"
        >
          Back
        </button>
        {step < 4 ? (
          <button
            type="button"
            onClick={handleNext}
            className="px-4 py-2 text-sm rounded-lg bg-[var(--cf-brand)] text-[var(--cf-on-brand)] font-medium self-end"
          >
            {editingFromReview ? "Save & return to review" : "Next"}
          </button>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-3 sm:items-center">
            <button
              type="button"
              onClick={() => router.back()}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleSubmit(true)}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] disabled:opacity-40"
            >
              {submittingAs === "draft" ? "Saving…" : "Save as draft"}
            </button>
            <button
              type="button"
              onClick={() => handleSubmit(false)}
              disabled={submitting || !canSubmitForReview}
              className="px-4 py-2 text-sm rounded-lg bg-[var(--cf-brand)] text-[var(--cf-on-brand)] font-medium disabled:opacity-40"
            >
              {submittingAs === "review" ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}

function clampStep(n: number): ApplicationWizardStep {
  if (n === 2 || n === 3 || n === 4) return n
  return 1
}

function validateCurrentStep(
  step: ApplicationWizardStep,
  data: ApplicationWizardData,
  products: ApplicationProduct[],
): ValidationErrors<ApplicationWizardData> {
  if (step === 1) return validateStep1ClientSelect(data)
  if (step === 2) return validateStep2LoanParams(data, products)
  if (step === 3) return validateStep3Affordability(data)
  if (step === 4) return validateStep4Review(data)
  return {}
}

function earliestStepWithErrors(
  errs: ValidationErrors<ApplicationWizardData>,
): ApplicationWizardStep {
  if (errs.clientId) return 1
  if (errs.productId || errs.appliedAmount || errs.appliedTermDays || errs.purpose) return 2
  if (errs.affordabilityFlag || errs.monthlyInstalment) return 3
  return 4
}
