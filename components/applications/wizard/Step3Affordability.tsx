"use client"

import { useEffect } from "react"
import { FieldGroup } from "@/components/wizard/FieldGroup"
import { calculateLoan } from "@/lib/loan-calculator"
import { deriveAffordabilityFlag } from "@/lib/validation/application-wizard"
import { displayCents } from "./formatters"
import { OwnLenderArrearsNotice } from "@/components/applications/OwnLenderArrearsNotice"
import type { ApplicationProduct, ApplicationWizardData, WizardMode } from "./types"
import type { ValidationErrors } from "@/lib/validation/application-wizard"
import { AFFORDABILITY_FAIL_REVIEW_COPY } from "@/lib/applications/wizard-copy"

export interface ClientForAffordability {
  monthlyIncome: number       // cents
  monthlyExpenses: number     // cents
  /** declared obligations plus the client's own loans with this lender (lib/affordability/own-lender-debt.ts) */
  debtObligations: { monthlyInstalment: number }[]
  /** "In arrears with us": the worst DPD and total overdue on their loans with this lender */
  ownLenderArrears?: { days: number; amountCents: number } | null
}

interface StepProps {
  data: ApplicationWizardData
  patch: (partial: Partial<ApplicationWizardData>) => void
  errors: ValidationErrors<ApplicationWizardData>
  // Reserved for portal-mode conditional rendering. Kept as deliberate seam.
  mode: WizardMode
  products: ApplicationProduct[]
  selectedClient: ClientForAffordability | null
}

// MARGINAL tonal styling kept for future credit-policy work — no code path
// currently emits MARGINAL (see deriveAffordabilityFlag in
// lib/validation/application-wizard.ts).
const FLAG_TONE: Record<"PASS" | "MARGINAL" | "FAIL", string> = {
  PASS: "bg-[var(--cf-success)]/15 border-[var(--cf-success)]/40 text-[var(--cf-success)]",
  MARGINAL: "bg-[var(--cf-warning)]/15 border-[var(--cf-warning)]/40 text-[var(--cf-warning)]",
  FAIL: "bg-[var(--cf-danger)]/15 border-[var(--cf-danger)]/40 text-[var(--cf-danger)]",
}

export function Step3Affordability({
  data,
  patch,
  errors,
  products,
  selectedClient,
}: StepProps) {
  const product = products.find((p) => p.id === data.productId)

  // Auto-run the affordability calc when the user lands on this step.
  // All calc inputs (productId, appliedAmount in rand, appliedTermDays, client
  // income) are finalised by the time Step 3 is reached.
  // appliedAmount is in rand strings in wizard state; convert to cents here.
  useEffect(() => {
    if (!product || !selectedClient || !data.appliedAmount || !data.appliedTermDays) return

    const principalCents = Math.round(Number(data.appliedAmount) * 100)
    const termDays = Number(data.appliedTermDays)
    if (principalCents <= 0 || termDays <= 0) return

    const result = calculateLoan({
      principal: principalCents,
      termDays,
      interestRatePm: product.interestRatePm,
      productType: product.productType,
      interestModel: product.interestModel,
      initiationFeeModel: product.initiationFeeModel,
      initiationFeePct: product.initiationFeePct,
      initiationFeeMax: product.initiationFeeMax,
      monthlyServiceFee: product.monthlyServiceFee,
    })

    // NDI in cents
    const totalExistingDebt = selectedClient.debtObligations.reduce(
      (sum, d) => sum + d.monthlyInstalment,
      0,
    )
    const ndi =
      selectedClient.monthlyIncome - selectedClient.monthlyExpenses - totalExistingDebt

    // NDI ≤ 0 → instalment cannot fit; emit FAIL directly (binary rule
    // assumes positive NDI). For positive NDI, percentage = 100 * inst / ndi.
    const flag: "PASS" | "MARGINAL" | "FAIL" =
      ndi <= 0
        ? "FAIL"
        : deriveAffordabilityFlag((100 * result.monthlyInstalment) / ndi)

    // Store as cents-formatted strings (e.g. "175000" → displayed divided by 100).
    // Clear recklessLendingConfirmed whenever the flag is non-FAIL so a user
    // who toggled it on a previous FAIL run can't leak a stale acknowledgement
    // into the audit trail after the calc flips back to PASS (NCA §80/§81).
    patch({
      monthlyInstalment: String(result.monthlyInstalment),
      firstInstalment: String(result.schedule[0]?.totalDue ?? result.monthlyInstalment),
      totalInterest: String(result.totalInterest),
      initiationFee: String(result.initiationFee),
      serviceFees: String(result.serviceFees),
      totalRepayable: String(result.totalRepayable),
      affordabilityFlag: flag,
      ...(flag !== "FAIL" && { recklessLendingConfirmed: false }),
    })
    // patch is stable (setState callback); deps cover all calc inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, data.appliedAmount, data.appliedTermDays, selectedClient])

  const flag = data.affordabilityFlag as "PASS" | "MARGINAL" | "FAIL" | ""

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Affordability summary</h2>
      <OwnLenderArrearsNotice arrears={selectedClient?.ownLenderArrears ?? null} />

      {/* Interest AND the lender fees are shown, so the summary foots on screen:
          amount + interest + initiation fee + service fees === total repayable.
          Showing interest alone left the fee difference unexplained on the very
          screen where staff certify the NCA §92 quotation.

          NOT complete cost of credit: a bundled credit-life premium (auto-added
          above R1,000 at the agreement stage) is disclosed in the PASQ and is
          not part of these figures. */}
      {/* Two grids, not one: four breakdown tiles fill a 4-col row exactly, and
          the outcome pair sits below. Five tiles plus a full-width total in a
          3-col grid would strand an empty cell (5 is not a multiple of 3). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Amount</p>
          <p className="text-lg font-semibold text-[var(--cf-text)]">
            {data.appliedAmount ? displayCents(String(Math.round(Number(data.appliedAmount) * 100))) : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Total interest</p>
          <p className="text-lg font-semibold text-[var(--cf-text)]">{displayCents(data.totalInterest)}</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Initiation fee</p>
          <p className="text-lg font-semibold text-[var(--cf-text)]">{displayCents(data.initiationFee)}</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Service fees</p>
          <p className="text-lg font-semibold text-[var(--cf-text)]">{displayCents(data.serviceFees)}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Monthly instalment</p>
          <p className="text-lg font-semibold text-[var(--cf-text)]">{displayCents(data.monthlyInstalment)}</p>
        </div>
        {/* The headline figure — accent border and larger type so it does not
            read as one more equal tile. */}
        <div className="rounded-lg border border-[var(--cf-brand)] bg-[var(--cf-bg-panel)] p-3">
          <p className="text-xs text-[var(--cf-text-muted)]">Total repayable</p>
          <p className="text-xl font-semibold text-[var(--cf-text)]">{displayCents(data.totalRepayable)}</p>
        </div>
      </div>

      {flag && (
        <div
          className={`rounded-lg border p-3 text-sm ${FLAG_TONE[flag]}`}
          role="status"
        >
          Affordability: <strong>{flag}</strong>
        </div>
      )}

      {errors.affordabilityFlag && (
        <p className="text-xs text-[var(--cf-danger)]" role="alert">
          {errors.affordabilityFlag}
        </p>
      )}

      {flag === "FAIL" && (
        <FieldGroup label="" error={errors.recklessLendingConfirmed}>
          <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
            <input
              type="checkbox"
              checked={data.recklessLendingConfirmed}
              onChange={(e) => patch({ recklessLendingConfirmed: e.target.checked })}
              className="mt-1"
            />
            <span>{AFFORDABILITY_FAIL_REVIEW_COPY}</span>
          </label>
        </FieldGroup>
      )}

      {!selectedClient && (
        <p className="text-sm text-[var(--cf-text-muted)]">
          No client selected — return to Step 1 to select a client.
        </p>
      )}
    </div>
  )
}
