import { FieldGroup } from "@/components/wizard/FieldGroup"
import { INP } from "./constants"
import type {
  ClientWizardData,
  DebtObligationInput,
  ExpenseBreakdownInputs,
  WizardMode,
} from "./types"
import {
  ACCOUNT_TYPES,
  EMPLOYMENT_STATUSES,
  INCOME_SOURCE_TYPES,
  UNEMPLOYED_STATUSES,
  type ClientWizardErrors,
} from "@/lib/validation/client-wizard"
import { minimumLivingExpense } from "@/lib/affordability/mle"
import { sumExpenseBreakdown } from "@/lib/affordability/sum-expense-breakdown"
import {
  DEBT_ACCOUNT_TYPES,
  debtAccountTypeLabel,
  normaliseDebtAccountType,
} from "@/lib/credit/debt-account-types"

interface StepProps {
  data: ClientWizardData
  patch: (partial: Partial<ClientWizardData>) => void
  errors: ClientWizardErrors
  mode: WizardMode
}

const EXPENSE_CATEGORIES: { key: keyof ExpenseBreakdownInputs; label: string }[] = [
  { key: "housing", label: "Housing" },
  { key: "transport", label: "Transport" },
  { key: "food", label: "Food" },
  { key: "education", label: "Education" },
  { key: "insurance", label: "Insurance" },
  { key: "clothing", label: "Clothing" },
  { key: "entertainment", label: "Entertainment" },
  { key: "medical", label: "Medical" },
  { key: "other", label: "Other" },
]



function randStringToCents(v: string): number {
  if (!v.trim() || !/^\d+(\.\d{1,2})?$/.test(v)) return 0
  return Math.round(parseFloat(v) * 100)
}

function formatRand(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function emptyDebtRow(): DebtObligationInput {
  return {
    // crypto.randomUUID is available in modern browsers + Node 19+. Used only
    // as a React key — stripped before the row is sent to the API.
    rowKey: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `row-${Date.now()}-${Math.random()}`,
    creditProvider: "",
    accountType: "OTHER",
    outstandingBalance: "",
    monthlyInstalment: "",
    notes: "",
  }
}

export function Step3Employment({ data, patch, errors }: StepProps) {
  const showEmployerFields =
    data.employmentStatus !== "" && !UNEMPLOYED_STATUSES.has(data.employmentStatus)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Employment &amp; income</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Employment status" required error={errors.employmentStatus}>
          <select
            className={INP}
            value={data.employmentStatus}
            onChange={(e) => {
              const status = e.target.value
              // Clear stale employer/salary fields when switching to a status
              // that hides them — otherwise typed values would persist in state
              // (and ship to the server on submit) even though the UI no longer
              // shows them.
              const cleared = UNEMPLOYED_STATUSES.has(status)
                ? {
                    employerName: "",
                    employerAddress: "",
                    employmentStartDate: "",
                    salaryPaymentDay: "",
                  }
                : {}
              patch({ employmentStatus: status, ...cleared })
            }}
          >
            <option value="">Select…</option>
            {EMPLOYMENT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </FieldGroup>
        <FieldGroup label="Income source" required error={errors.incomeSourceType}>
          <select
            className={INP}
            value={data.incomeSourceType}
            onChange={(e) => patch({ incomeSourceType: e.target.value })}
          >
            <option value="">Select…</option>
            {INCOME_SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </FieldGroup>
      </div>

      {showEmployerFields && (
        <>
          <FieldGroup label="Employer name" required error={errors.employerName}>
            <input
              className={INP}
              value={data.employerName}
              onChange={(e) => patch({ employerName: e.target.value })}
              autoComplete="organization"
            />
          </FieldGroup>
          <FieldGroup label="Employer address" required error={errors.employerAddress}>
            <input
              className={INP}
              value={data.employerAddress}
              onChange={(e) => patch({ employerAddress: e.target.value })}
            />
          </FieldGroup>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FieldGroup label="Employment start date" required error={errors.employmentStartDate}>
              <input
                type="date"
                className={INP}
                value={data.employmentStartDate}
                onChange={(e) => patch({ employmentStartDate: e.target.value })}
              />
            </FieldGroup>
            <FieldGroup label="Salary payment day" required error={errors.salaryPaymentDay} hint="1–31">
              <input
                className={INP}
                value={data.salaryPaymentDay}
                onChange={(e) =>
                  patch({ salaryPaymentDay: e.target.value.replace(/\D/g, "").slice(0, 2) })
                }
                inputMode="numeric"
              />
            </FieldGroup>
          </div>
        </>
      )}

      <FieldGroup label="Account type" required error={errors.accountType}>
        <select
          className={INP}
          value={data.accountType}
          onChange={(e) => patch({ accountType: e.target.value })}
        >
          <option value="">Select…</option>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </FieldGroup>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Net monthly income (R)" required error={errors.monthlyIncome}>
          <input
            className={INP}
            value={data.monthlyIncome}
            onChange={(e) => patch({ monthlyIncome: e.target.value })}
            inputMode="decimal"
          />
        </FieldGroup>
        <FieldGroup
          label="Gross monthly income (R)"
          error={errors.grossMonthlyIncome}
          hint="Used to compute the NCA Regulation 23A minimum-living-expense floor"
        >
          <input
            className={INP}
            value={data.grossMonthlyIncome}
            onChange={(e) => patch({ grossMonthlyIncome: e.target.value })}
            inputMode="decimal"
          />
        </FieldGroup>
      </div>

      {(() => {
        const breakdownCents = {
          housing: randStringToCents(data.expenseBreakdown.housing),
          transport: randStringToCents(data.expenseBreakdown.transport),
          food: randStringToCents(data.expenseBreakdown.food),
          education: randStringToCents(data.expenseBreakdown.education),
          insurance: randStringToCents(data.expenseBreakdown.insurance),
          clothing: randStringToCents(data.expenseBreakdown.clothing),
          entertainment: randStringToCents(data.expenseBreakdown.entertainment),
          medical: randStringToCents(data.expenseBreakdown.medical),
          other: randStringToCents(data.expenseBreakdown.other),
        }
        const sumCents = sumExpenseBreakdown(breakdownCents)
        const grossCents = randStringToCents(data.grossMonthlyIncome)
        const floorCents = grossCents > 0 ? minimumLivingExpense(grossCents) : 0
        const belowFloor = grossCents > 0 && sumCents < floorCents
        return (
          <div className="space-y-3 border border-[var(--cf-border-subtle)] rounded-lg p-4 bg-[var(--cf-bg-raised)]">
            <h3 className="text-md font-semibold text-[var(--cf-text)]">Monthly expenses by category (R)</h3>
            <p className="text-xs text-[var(--cf-text-muted)]">
              Capture each category — leave blank for zero. The total replaces the
              previous single &quot;monthly expenses&quot; field for NCA §80 evidence.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {EXPENSE_CATEGORIES.map((cat) => (
                <FieldGroup key={cat.key} label={cat.label} error={errors.expenseBreakdown?.[cat.key]}>
                  <input
                    className={INP}
                    value={data.expenseBreakdown[cat.key]}
                    onChange={(e) =>
                      patch({
                        expenseBreakdown: { ...data.expenseBreakdown, [cat.key]: e.target.value },
                      })
                    }
                    inputMode="decimal"
                    placeholder="0"
                  />
                </FieldGroup>
              ))}
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-[var(--cf-border-subtle)]">
              <span className="text-[var(--cf-text-muted)]">Captured total</span>
              <span className="font-semibold text-[var(--cf-brand)]">R {formatRand(sumCents)}</span>
            </div>
            {grossCents > 0 && (
              <div className="flex justify-between text-xs text-[var(--cf-text-muted)]">
                <span>NCA Reg 23A floor for this income</span>
                <span>R {formatRand(floorCents)}</span>
              </div>
            )}
            {belowFloor && (
              <div className="rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/10 p-3 space-y-2">
                <p className="text-xs text-[var(--cf-warning)]">
                  Captured expenses (R {formatRand(sumCents)}) are below the NCA
                  Regulation 23A minimum for this income (R {formatRand(floorCents)}).
                  A written justification is required before saving.
                </p>
                <FieldGroup
                  label="Justification (required)"
                  required
                  error={errors.expenseBreakdown?.belowMleJustification}
                >
                  <textarea
                    className={INP}
                    rows={3}
                    value={data.expenseBreakdown.belowMleJustification}
                    onChange={(e) =>
                      patch({
                        expenseBreakdown: {
                          ...data.expenseBreakdown,
                          belowMleJustification: e.target.value,
                        },
                      })
                    }
                    placeholder="Why the captured total is plausibly below the regulatory minimum (e.g. client lives with extended family, no transport costs, etc.)"
                  />
                </FieldGroup>
              </div>
            )}
          </div>
        )
      })()}

      <div className="space-y-3 border border-[var(--cf-border-subtle)] rounded-lg p-4 bg-[var(--cf-bg-raised)]">
        <div className="flex items-center justify-between">
          <h3 className="text-md font-semibold text-[var(--cf-text)]">Existing debt obligations</h3>
          <button
            type="button"
            onClick={() =>
              patch({ debtObligations: [...data.debtObligations, emptyDebtRow()] })
            }
            className="text-xs px-3 py-1.5 rounded-md border border-[var(--cf-brand)] text-[var(--cf-brand)] hover:bg-[var(--cf-brand)]/10"
          >
            + Add debt
          </button>
        </div>
        {data.debtObligations.length === 0 && (
          <p className="text-xs text-[var(--cf-text-muted)]">No debt obligations captured.</p>
        )}
        {data.debtObligations.map((row, i) => {
          const rowErrs = errors.debtObligations?.[i]
          const updateRow = (partial: Partial<DebtObligationInput>) =>
            patch({
              debtObligations: data.debtObligations.map((r, idx) =>
                idx === i ? { ...r, ...partial } : r,
              ),
            })
          return (
            <div
              key={row.rowKey}
              className="rounded-md border border-[var(--cf-border-subtle)] p-3 space-y-3"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldGroup label="Credit provider" required error={rowErrs?.creditProvider}>
                  <input
                    className={INP}
                    value={row.creditProvider}
                    onChange={(e) => updateRow({ creditProvider: e.target.value })}
                  />
                </FieldGroup>
                <FieldGroup label="Account type" error={rowErrs?.accountType}>
                  <select
                    className={INP}
                    value={normaliseDebtAccountType(row.accountType) ?? ""}
                    onChange={(e) => updateRow({ accountType: e.target.value })}
                  >
                    {/* Name a value we cannot place instead of silently
                        showing the first option as if it were the answer. */}
                    {normaliseDebtAccountType(row.accountType) === null && (
                      <option value="">{debtAccountTypeLabel(row.accountType)}</option>
                    )}
                    {DEBT_ACCOUNT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </FieldGroup>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldGroup label="Outstanding balance (R)" required error={rowErrs?.outstandingBalance}>
                  <input
                    className={INP}
                    value={row.outstandingBalance}
                    onChange={(e) => updateRow({ outstandingBalance: e.target.value })}
                    inputMode="decimal"
                  />
                </FieldGroup>
                <FieldGroup label="Monthly instalment (R)" required error={rowErrs?.monthlyInstalment}>
                  <input
                    className={INP}
                    value={row.monthlyInstalment}
                    onChange={(e) => updateRow({ monthlyInstalment: e.target.value })}
                    inputMode="decimal"
                  />
                </FieldGroup>
              </div>
              <FieldGroup label="Notes" error={rowErrs?.notes} hint="Optional">
                <textarea
                  className={INP}
                  rows={2}
                  value={row.notes}
                  onChange={(e) => updateRow({ notes: e.target.value })}
                />
              </FieldGroup>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    patch({ debtObligations: data.debtObligations.filter((_, idx) => idx !== i) })
                  }
                  className="text-xs px-3 py-1 rounded-md border border-[var(--cf-danger)]/60 text-[var(--cf-danger)] hover:bg-[var(--cf-danger)]/10"
                >
                  Remove
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Bank name" required error={errors.bankName}>
          <input
            className={INP}
            value={data.bankName}
            onChange={(e) => patch({ bankName: e.target.value })}
          />
        </FieldGroup>
        <FieldGroup label="Branch code" required error={errors.bankBranchCode} hint="6-digit universal code">
          <input
            className={INP}
            value={data.bankBranchCode}
            onChange={(e) =>
              patch({ bankBranchCode: e.target.value.replace(/\D/g, "").slice(0, 6) })
            }
            inputMode="numeric"
          />
        </FieldGroup>
      </div>

      <FieldGroup label="Bank account number" required error={errors.bankAccountNumber}>
        <input
          className={INP}
          value={data.bankAccountNumber}
          onChange={(e) =>
            patch({ bankAccountNumber: e.target.value.replace(/\D/g, "").slice(0, 16) })
          }
          inputMode="numeric"
        />
      </FieldGroup>

      <h3 className="text-md font-semibold text-[var(--cf-text)] mt-6">Next of kin</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Name" required error={errors.nextOfKinName}>
          <input
            className={INP}
            value={data.nextOfKinName}
            onChange={(e) => patch({ nextOfKinName: e.target.value })}
          />
        </FieldGroup>
        <FieldGroup label="Relationship" required error={errors.nextOfKinRelationship}>
          <input
            className={INP}
            value={data.nextOfKinRelationship}
            onChange={(e) => patch({ nextOfKinRelationship: e.target.value })}
          />
        </FieldGroup>
      </div>
      <FieldGroup label="Phone" required error={errors.nextOfKinPhone}>
        <input
          type="tel"
          className={INP}
          value={data.nextOfKinPhone}
          onChange={(e) => patch({ nextOfKinPhone: e.target.value })}
        />
      </FieldGroup>
    </div>
  )
}
