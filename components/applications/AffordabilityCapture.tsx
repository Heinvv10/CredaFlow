"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, PlusCircle, Trash2, TrendingDown, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assessAffordability, affordabilityRiskGrade } from "@/lib/affordability/ndi"
import {
  DEBT_ACCOUNT_TYPES,
  debtAccountTypeLabel,
  normaliseDebtAccountType,
  preserveOriginalDebtAccountType,
  captureOriginalDebtAccountTypes,
} from "@/lib/credit/debt-account-types"
import { OwnLenderDebtRows, ownLenderPreview } from "@/components/applications/OwnLenderDebtRows"

interface DebtEntry {
  sourceId?: string | null
  creditor: string
  type: string
  monthlyInstalment: number
  balance: number
  notes?: string | null
}

interface Props {
  applicationId: string
  monthlyIncome: number
  monthlyExpenses: number
  existingDebts: DebtEntry[]
  clientDebtTotal: number
  ownLenderDebts?: import("@/lib/affordability/own-lender-debt").OwnLenderDebts | null // live only; null once locked
  proposedInstalment: number
  affordabilityNDI?: number | null
  done: boolean
  readOnly?: boolean
  snapshotUnavailable?: boolean
  debtEvidenceInvalid?: boolean
  clientDebtEvidenceInvalid?: boolean
  lockedAssessment?: {
    totalExistingDebt: number
    netDisposableIncome: number
    ndiAfterLoan: number
    isAffordable: boolean
  }
}

// This panel used to carry its own Title Case list while the client surfaces
// wrote UPPER_SNAKE and lower_snake into the same free-text column. A value
// from another vocabulary matched no <option>, so the select displayed its
// FIRST entry — "Home Loan" — for every unmatched row. See lib/credit/debt-account-types.ts.

function formatZAR(cents: number) {
  return `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function AffordabilityCapture({ applicationId, monthlyIncome, monthlyExpenses, existingDebts: initialDebts, clientDebtTotal, ownLenderDebts = null, proposedInstalment, affordabilityNDI: _affordabilityNDI, done, readOnly = false, snapshotUnavailable = false, debtEvidenceInvalid = false, clientDebtEvidenceInvalid = false, lockedAssessment }: Props) {
  const router = useRouter()
  const [debts, setDebts] = useState<DebtEntry[]>(initialDebts?.length > 0 ? initialDebts : [])
  // The type as STORED, before this panel rendered it canonically. Re-picking
  // the same meaning must not rewrite the bytes — that moves the approval
  // fingerprint and blocks payout. Captured once; edits never change it.
  //
  // Keyed by sourceId, NOT by position: rows are added and removed here, so a
  // positional key would hand one row another row's original value after any
  // removal. A row without a sourceId is new and has no stored bytes to keep.
  const [originalTypes] = useState<Map<string, string>>(
    () => captureOriginalDebtAccountTypes(
      (initialDebts ?? []).map((d) => ({ key: d.sourceId, type: d.type })),
    ),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalidDebtEvidence = debtEvidenceInvalid || clientDebtEvidenceInvalid
  const debtInputsReadOnly = readOnly || clientDebtEvidenceInvalid
  const [saved, setSaved] = useState(done && !invalidDebtEvidence)

  function addDebt() {
    setDebts(d => [...d, { sourceId: null, creditor: "", type: "PERSONAL_LOAN", monthlyInstalment: 0, balance: 0, notes: null }])
  }

  function removeDebt(i: number) {
    setDebts(d => d.filter((_, idx) => idx !== i))
  }

  function updateDebt(i: number, field: keyof DebtEntry, value: string | number) {
    setDebts(d => d.map((item, idx) => idx === i ? { ...item, [field]: value } : item))
  }

  // All money is in CENTS — DebtEntry instalments/balances, the income/expense
  // props, and the proposed instalment. This preview mirrors the server recompute
  // (lib/affordability/ndi) exactly, so the staff view and the persisted, audited
  // NDI agree (the old code treated cents debts as rands → 100x off).
  const applicationDebtTotal = debts.reduce(
    (sum, debt) => sum + Math.max(0, Math.round(debt.monthlyInstalment || 0)),
    0,
  ) + ownLenderPreview(debts, ownLenderDebts).instalments // as the server adds obligations to this lender
  const calculatedAssessment = assessAffordability({
    monthlyIncomeCents: monthlyIncome,
    monthlyExpensesCents: monthlyExpenses,
    debts: [{ monthlyInstalment: Math.max(applicationDebtTotal, clientDebtTotal) }],
    proposedInstalmentCents: proposedInstalment,
  })
  const assessment = lockedAssessment
    ? {
        totalExistingDebt: lockedAssessment.totalExistingDebt,
        discretionaryIncome: monthlyIncome - monthlyExpenses,
        netDisposableIncome: lockedAssessment.netDisposableIncome,
        ndiAfterLoan: lockedAssessment.ndiAfterLoan,
        ratio: proposedInstalment / Math.max(1, monthlyIncome - monthlyExpenses),
        isAffordable: lockedAssessment.isAffordable,
      }
    : calculatedAssessment
  const totalExistingDebt = assessment.totalExistingDebt
  const ndi = assessment.netDisposableIncome
  const ndiAfterLoan = assessment.ndiAfterLoan
  const isAffordable = assessment.isAffordable

  const RISK_TONE: Record<string, string> = {
    A: "text-[var(--cf-success)] bg-[rgba(63,191,127,0.14)]",
    B: "text-[var(--cf-info)] bg-[rgba(111,159,203,0.14)]",
    C: "text-[var(--cf-warning)] bg-[rgba(217,154,58,0.15)]",
    D: "text-[var(--cf-danger)] bg-[rgba(208,92,75,0.16)]",
  }
  const grade = affordabilityRiskGrade(assessment)
  const risk = { grade, tone: RISK_TONE[grade] }

  async function save() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/affordability`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Only the debt list is sent; the server recomputes + persists NDI from
        // the application's own financials (it never trusts a client-posted NDI).
        body: JSON.stringify({
          existingDebtObligations: debts.map((debt) => ({
            ...debt,
            type: preserveOriginalDebtAccountType(
              debt.type,
              debt.sourceId ? originalTypes.get(debt.sourceId) : undefined,
            ),
          })),
        }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setError(d.error ?? "Failed to save")
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(false)
    }
  }

  if (snapshotUnavailable) {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgba(208,92,75,0.32)] bg-[var(--cf-bg-panel)]">
        <div className="border-b border-[rgba(208,92,75,0.26)] bg-[rgba(208,92,75,0.08)] px-5 py-3">
          <span className="text-sm font-semibold text-[var(--cf-text)]">Affordability Assessment</span>
        </div>
        <div className="p-5">
          <p className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4 text-sm text-[var(--cf-danger)]">
            Immutable affordability evidence is missing. Live client values are not substituted for the decision record. Return this application to review and reassess it before disbursement.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`overflow-hidden rounded-lg border bg-[var(--cf-bg-panel)] ${saved ? "border-[rgba(63,191,127,0.32)]" : "border-[var(--cf-border-subtle)]"}`}>
      <div className={`flex items-center justify-between border-b px-5 py-3 ${saved ? "border-[rgba(63,191,127,0.26)] bg-[rgba(63,191,127,0.08)]" : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]"}`}>
        <div className="flex items-center gap-2">
          {saved ? <CheckCircle className="h-4 w-4 text-[var(--cf-success)]" /> : <div className="h-4 w-4 rounded-full border-2 border-[var(--cf-warning)]" />}
          <span className="text-sm font-semibold text-[var(--cf-text)]">Affordability Assessment</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--cf-text-muted)]">Risk Grade</span>
          {invalidDebtEvidence ? (
            <span className="rounded-full bg-[rgba(208,92,75,0.16)] px-2.5 py-0.5 text-sm font-bold text-[var(--cf-danger)]">
              Unavailable
            </span>
          ) : (
            <span className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${risk.tone}`}>{risk.grade}</span>
          )}
        </div>
      </div>

      <div className="space-y-5 p-5">
        {invalidDebtEvidence ? (
          <div className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4 text-sm text-[var(--cf-danger)]">
            <p className="font-semibold">{clientDebtEvidenceInvalid ? "Stored client debt evidence is invalid" : "Stored debt evidence is invalid"} — affordability is not calculated.</p>
            <p className="mt-1 text-[var(--cf-text-secondary)]">
              {clientDebtEvidenceInvalid
                ? "Repair the debt obligations in the client financial profile, then reassess this application."
                : readOnly
                ? "Return the application to review, then re-enter every obligation and reassess it."
                : "Re-enter every obligation below. Save an empty list only after confirming that the client has no existing debt."}
            </p>
          </div>
        ) : (
        <div className={`rounded-lg border p-4 ${isAffordable ? "border-[rgba(63,191,127,0.28)] bg-[rgba(63,191,127,0.08)]" : "border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)]"}`}>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Metric label="Monthly Income" value={formatZAR(monthlyIncome)} />
            <Metric label="Living Expenses" value={`- ${formatZAR(monthlyExpenses)}`} tone="danger" />
            <Metric label="Existing Debt" value={`- ${formatZAR(totalExistingDebt)}`} tone="warning" />
            <Metric label="NDI" value={formatZAR(ndi)} tone={ndi >= 0 ? "success" : "danger"} />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--cf-border-subtle)] pt-3">
            <Metric label="Proposed Instalment" value={`- ${formatZAR(proposedInstalment)}`} />
            <div className="text-right">
              <p className="text-xs text-[var(--cf-text-muted)]">NDI After Loan</p>
              <p className={`whitespace-nowrap text-lg font-bold ${ndiAfterLoan >= 0 ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>
                {formatZAR(ndiAfterLoan)}
              </p>
            </div>
            <div className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${isAffordable ? "bg-[rgba(63,191,127,0.18)] text-[var(--cf-success)]" : "bg-[rgba(208,92,75,0.18)] text-[var(--cf-danger)]"}`}>
              {isAffordable ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {isAffordable ? "AFFORDABLE" : "NOT AFFORDABLE"}
            </div>
          </div>
        </div>
        )}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-[var(--cf-text-secondary)]">Existing Credit Obligations</p>
            <button onClick={addDebt} disabled={debtInputsReadOnly} className="flex items-center gap-1.5 text-xs font-medium text-[var(--cf-brand-soft)] hover:underline disabled:cursor-not-allowed disabled:opacity-50">
              <PlusCircle className="h-3.5 w-3.5" />
              Add creditor
            </button>
          </div>

          {debts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--cf-border-subtle)] py-5 text-center text-sm text-[var(--cf-text-muted)]">
              {clientDebtEvidenceInvalid
                ? "Application obligations cannot be assessed until the client debt record is repaired."
                : debtEvidenceInvalid
                ? "No valid obligation rows can be recovered. Add every creditor, or save only after confirming an explicit no-debt declaration."
                : "No existing debt obligations captured. Click \"Add creditor\" if applicable."}
            </div>
          ) : (
            <div className="space-y-2">
              {debts.map((debt, i) => (
                <div key={debt.sourceId ?? `new-${i}`} className="grid grid-cols-12 items-center gap-2">
                  <input value={debt.creditor} disabled={debtInputsReadOnly} onChange={e => updateDebt(i, "creditor", e.target.value)} placeholder="Creditor name" className="col-span-4 rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-1.5 text-xs text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)] disabled:cursor-not-allowed disabled:opacity-70" />
                  <select value={normaliseDebtAccountType(debt.type) ?? ""} disabled={debtInputsReadOnly} onChange={e => updateDebt(i, "type", e.target.value)} className="col-span-3 rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2 py-1.5 text-xs text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)] disabled:cursor-not-allowed disabled:opacity-70">
                    {/* A value we cannot place must SAY so. Rendering the list
                        alone would show "Home loan" for it, which is how a
                        mis-typed record reads as a declaration nobody made. */}
                    {normaliseDebtAccountType(debt.type) === null && (
                      <option value="" disabled>{debtAccountTypeLabel(debt.type)}</option>
                    )}
                    {DEBT_ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <MoneyInput value={debt.monthlyInstalment} disabled={debtInputsReadOnly} placeholder="Monthly" onChange={(value) => updateDebt(i, "monthlyInstalment", value)} className="col-span-2" />
                  <MoneyInput value={debt.balance} disabled={debtInputsReadOnly} placeholder="Balance" onChange={(value) => updateDebt(i, "balance", value)} className="col-span-2" />
                  <button onClick={() => removeDebt(i)} disabled={debtInputsReadOnly} className="col-span-1 flex justify-center text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:cursor-not-allowed disabled:opacity-50">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <p className="pl-1 text-[10px] text-[var(--cf-text-muted)]">Columns: Creditor / Type / Monthly Instalment (R) / Outstanding Balance (R)</p>
            </div>
          )}
        </div>

        <OwnLenderDebtRows debts={debts} own={ownLenderDebts} />
        {error && <p className="rounded border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] px-3 py-2 text-xs text-[var(--cf-danger)]">{error}</p>}

        <div className="flex justify-end">
          <Button onClick={save} disabled={loading || debtInputsReadOnly}>
            {clientDebtEvidenceInvalid ? "Client Debt Repair Required" : readOnly ? "Decision Snapshot Locked" : loading ? "Saving..." : saved ? "Update Affordability" : "Save Affordability Assessment"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" | "danger" }) {
  const color = tone === "success" ? "text-[var(--cf-success)]" : tone === "warning" ? "text-[var(--cf-warning)]" : tone === "danger" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"
  return (
    <div>
      <p className="text-xs text-[var(--cf-text-muted)]">{label}</p>
      <p className={`whitespace-nowrap font-bold ${color}`}>{value}</p>
    </div>
  )
}

function MoneyInput({ value, onChange, placeholder, className, disabled = false }: { value: number; onChange: (value: number) => void; placeholder: string; className?: string; disabled?: boolean }) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-[var(--cf-text-muted)]">R</span>
      <input
        type="number"
        disabled={disabled}
        value={value ? value / 100 : ""}
        onChange={e => onChange(Math.round((parseFloat(e.target.value) || 0) * 100))}
        placeholder={placeholder}
        className="w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] py-1.5 pl-6 pr-2 text-xs text-[var(--cf-text)] outline-none focus:ring-1 focus:ring-[var(--cf-brand)] disabled:cursor-not-allowed disabled:opacity-70"
      />
    </div>
  )
}
