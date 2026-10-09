"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { StepBar } from "@/components/wizard/StepBar"
import { sessionWizardStore } from "@/lib/wizard/session-storage"
import {
  earliestStepWithErrors,
  validateStep1Identity,
  validateStep2Address,
  validateStep3Employment,
  validateStep4Review,
  type ClientWizardErrors,
} from "@/lib/validation/client-wizard"
import {
  CLIENT_WIZARD_STEP_LABELS,
  EMPTY_CLIENT_WIZARD_DATA,
  type ClientWizardData,
  type ClientWizardStep,
  type WizardMode,
} from "./types"
import { CLIENT_WIZARD_STORAGE_KEY } from "./constants"
import { Step1Identity } from "./Step1Identity"
import { Step2Address } from "./Step2Address"
import { Step3Employment } from "./Step3Employment"
import { Step4Review } from "./Step4Review"

interface Props {
  mode: WizardMode
}

export function ClientWizard({ mode }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const store = useMemo(
    () => sessionWizardStore<ClientWizardData>(CLIENT_WIZARD_STORAGE_KEY),
    [],
  )

  const [data, setData] = useState<ClientWizardData>(EMPTY_CLIENT_WIZARD_DATA)
  const [step, setStep] = useState<ClientWizardStep>(1)
  const [errors, setErrors] = useState<ClientWizardErrors>({})
  const [editingFromReview, setEditingFromReview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const hydrated = useRef(false)

  // Hydrate from sessionStorage + URL on mount
  useEffect(() => {
    if (hydrated.current) return
    const saved = store.load()
    if (saved) setData(saved)

    const urlStep = clampStep(Number(searchParams.get("step") ?? "1"))
    setStep(urlStep)
    hydrated.current = true
  }, [searchParams, store])

  // Sync state.step when the URL changes (browser back/forward)
  useEffect(() => {
    if (!hydrated.current) return
    const urlStep = clampStep(Number(searchParams.get("step") ?? "1"))
    setStep((prev) => {
      if (urlStep !== prev) {
        setEditingFromReview(false)
        setErrors({})
        return urlStep
      }
      return prev
    })
  }, [searchParams])

  // Persist data on every change
  useEffect(() => {
    if (hydrated.current) store.save(data)
  }, [data, store])

  const patch = (partial: Partial<ClientWizardData>) =>
    setData((d) => ({ ...d, ...partial }))

  function goTo(
    n: ClientWizardStep,
    opts: { fromReview?: boolean; preserveErrors?: boolean } = {},
  ) {
    setStep(n)
    setEditingFromReview(opts.fromReview ?? false)
    if (!opts.preserveErrors) setErrors({})
    router.replace(`?step=${n}`)
  }

  function handleBack() {
    if (step <= 1) return
    goTo((step - 1) as ClientWizardStep)
  }

  function handleNext() {
    const stepErrs = validateCurrentStep(step, data)
    if (Object.keys(stepErrs).length > 0) {
      setErrors(stepErrs)
      return
    }
    const next: ClientWizardStep = editingFromReview ? 4 : ((step + 1) as ClientWizardStep)
    goTo(next)
  }

  async function handleSubmit() {
    // Step 4 has inline validation (POPIA consent). Gate the submit on it
    // so the user gets immediate red-text feedback rather than a round-trip
    // through the server. The server still validates (defense in depth).
    const stepErrs = validateStep4Review(data)
    if (Object.keys(stepErrs).length > 0) {
      setErrors(stepErrs)
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; errors?: ClientWizardErrors }
        if (body.errors && Object.keys(body.errors).length > 0) {
          // Field-level server errors: jump to the earliest offending step
          // and surface the red field-level messages. No toast/banner noise
          // on top — the inline errors ARE the user-facing signal.
          setErrors(body.errors)
          goTo(earliestStepWithErrors(body.errors), { preserveErrors: true })
          setSubmitError(null)
          return
        }
        throw new Error(body.error ?? "Failed to save client")
      }
      store.clear()
      toast.success("Client created")
      router.push("/clients")
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An error occurred"
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <StepBar step={step} labels={CLIENT_WIZARD_STEP_LABELS} />

      {step === 1 && (
        <Step1Identity data={data} patch={patch} errors={errors} mode={mode} />
      )}
      {step === 2 && (
        <Step2Address data={data} patch={patch} errors={errors} mode={mode} />
      )}
      {step === 3 && (
        <Step3Employment data={data} patch={patch} errors={errors} mode={mode} />
      )}
      {step === 4 && (
        <Step4Review
          data={data}
          patch={patch}
          errors={errors}
          editJump={(n) => goTo(n, { fromReview: true })}
          mode={mode}
        />
      )}

      {submitError && (
        <div className="mt-4 rounded-lg border border-[var(--cf-danger)]/30 bg-[var(--cf-danger)]/10 p-3 text-sm text-[var(--cf-danger)]">
          {submitError}
        </div>
      )}

      <footer className="mt-6 flex justify-between">
        <button
          type="button"
          onClick={handleBack}
          disabled={step <= 1}
          className="px-4 py-2 text-sm rounded-lg border border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] disabled:opacity-40"
        >
          Back
        </button>
        {step < 4 ? (
          <button
            type="button"
            onClick={handleNext}
            className="px-4 py-2 text-sm rounded-lg bg-[var(--cf-brand)] text-[var(--cf-on-brand)] font-medium"
          >
            {editingFromReview ? "Save & return to review" : "Next"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm rounded-lg bg-[var(--cf-brand)] text-[var(--cf-on-brand)] font-medium disabled:opacity-40"
          >
            {submitting ? "Saving…" : "Create client"}
          </button>
        )}
      </footer>
    </div>
  )
}

// --- helpers (kept inside this file; small enough not to warrant extraction) ---

function clampStep(n: number): ClientWizardStep {
  if (n === 2 || n === 3 || n === 4) return n
  return 1
}

function validateCurrentStep(
  step: ClientWizardStep,
  data: ClientWizardData,
): ClientWizardErrors {
  if (step === 1) return validateStep1Identity(data)
  if (step === 2) return validateStep2Address(data)
  if (step === 3) return validateStep3Employment(data)
  if (step === 4) return validateStep4Review(data)
  return {}
}
