import { bankLabel } from "@/lib/banks"
import type { ClientWizardData, WizardMode } from "./types"
import { accountTypeLabel, type ClientWizardErrors } from "@/lib/validation/client-wizard"
import { sumExpenseBreakdown } from "@/lib/affordability/sum-expense-breakdown"
import { formatZAR } from "@/lib/utils"

interface StepProps {
  data: ClientWizardData
  patch: (partial: Partial<ClientWizardData>) => void
  errors: ClientWizardErrors
  editJump: (n: 1 | 2 | 3) => void
  mode: WizardMode
}

function toCents(v: string): number {
  if (!v.trim() || !/^\d+(\.\d{1,2})?$/.test(v)) return 0
  return Math.round(parseFloat(v) * 100)
}

function countNonZero(b: ClientWizardData["expenseBreakdown"]): number {
  let count = 0
  for (const k of ["housing", "transport", "food", "education", "insurance", "clothing", "entertainment", "medical", "other"] as const) {
    if (toCents(b[k]) > 0) count++
  }
  return count
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) {
    return (
      <div className="grid grid-cols-3 gap-3 text-sm py-1">
        <dt className="text-[var(--cf-text-muted)]">{label}</dt>
        <dd className="col-span-2 text-[var(--cf-text-muted)]">—</dd>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-3 text-sm py-1">
      <dt className="text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="col-span-2 text-[var(--cf-text)]">{value}</dd>
    </div>
  )
}

function Section({
  title,
  step,
  editJump,
  children,
}: {
  title: string
  step: 1 | 2 | 3
  editJump: (n: 1 | 2 | 3) => void
  children: React.ReactNode
}) {
  return (
    <section className="bg-[var(--cf-bg-panel)] border border-[var(--cf-border-subtle)] rounded-xl p-4">
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--cf-text)]">{title}</h3>
        <button
          type="button"
          onClick={() => editJump(step)}
          className="text-xs text-[var(--cf-brand)] hover:text-[var(--cf-brand-alt)] transition-colors"
        >
          Edit
        </button>
      </header>
      <dl className="divide-y divide-[var(--cf-border-subtle)]">{children}</dl>
    </section>
  )
}

export function Step4Review({ data, patch, errors, editJump }: StepProps) {
  const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ") || undefined

  const kinSummary =
    data.nextOfKinName && data.nextOfKinRelationship
      ? `${data.nextOfKinName} (${data.nextOfKinRelationship})`
      : data.nextOfKinName || undefined

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Review &amp; submit</h2>
      <p className="text-sm text-[var(--cf-text-secondary)]">
        Check the details below, then click <strong>Create client</strong> to save.
      </p>

      <Section title="Identity" step={1} editJump={editJump}>
        <Row label="Full name" value={fullName} />
        <Row label="SA ID" value={data.idNumber} />
        <Row label="Date of birth" value={data.dateOfBirth} />
        <Row label="Gender" value={data.gender} />
        <Row label="Email" value={data.email} />
        <Row label="Mobile" value={data.phone} />
        <Row label="WhatsApp" value={data.whatsapp} />
      </Section>

      <Section title="Address" step={2} editJump={editJump}>
        <Row label="Line 1" value={data.addressLine1} />
        <Row label="Suburb" value={data.suburb} />
        <Row label="City" value={data.city} />
        <Row label="Province" value={data.province} />
        <Row label="Postal code" value={data.postalCode} />
      </Section>

      <Section title="Employment &amp; income" step={3} editJump={editJump}>
        <Row label="Status" value={data.employmentStatus} />
        <Row label="Income source" value={data.incomeSourceType} />
        <Row label="Employer" value={data.employerName} />
        <Row label="Start date" value={data.employmentStartDate} />
        <Row label="Salary day" value={data.salaryPaymentDay} />
        <Row
          label="Net monthly"
          value={data.monthlyIncome ? formatZAR(toCents(data.monthlyIncome)) : undefined}
        />
        <Row
          label="Gross monthly"
          value={data.grossMonthlyIncome ? formatZAR(toCents(data.grossMonthlyIncome)) : undefined}
        />
        <Row
          label="Monthly expenses"
          value={(() => {
            const cents = sumExpenseBreakdown({
              housing: toCents(data.expenseBreakdown.housing),
              transport: toCents(data.expenseBreakdown.transport),
              food: toCents(data.expenseBreakdown.food),
              education: toCents(data.expenseBreakdown.education),
              insurance: toCents(data.expenseBreakdown.insurance),
              clothing: toCents(data.expenseBreakdown.clothing),
              entertainment: toCents(data.expenseBreakdown.entertainment),
              medical: toCents(data.expenseBreakdown.medical),
              other: toCents(data.expenseBreakdown.other),
            })
            return cents > 0 ? `${formatZAR(cents)} (across ${countNonZero(data.expenseBreakdown)} categories)` : undefined
          })()}
        />
        <Row
          label="MLE justification"
          value={data.expenseBreakdown.belowMleJustification || undefined}
        />
        <Row
          label="Existing debt obligations"
          value={
            data.debtObligations.length === 0
              ? undefined
              : `${data.debtObligations.length} row(s) — total instalment ${formatZAR(
                  data.debtObligations.reduce((s, r) => s + toCents(r.monthlyInstalment), 0),
                )}`
          }
        />
        <Row label="Bank" value={bankLabel(data.bankName)} />
        <Row label="Branch code" value={data.bankBranchCode} />
        <Row label="Account no." value={data.bankAccountNumber} />
        <Row label="Account type" value={accountTypeLabel(data.accountType)} />
        <Row label="Next of kin" value={kinSummary} />
        <Row label="Kin phone" value={data.nextOfKinPhone} />
      </Section>

      <section className="bg-[var(--cf-bg-panel)] border border-[var(--cf-border-subtle)] rounded-xl p-4">
        <header className="mb-2">
          <h3 className="text-sm font-semibold text-[var(--cf-text)]">Compliance</h3>
        </header>
        <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
          <input
            type="checkbox"
            checked={data.popiaConsentGiven}
            onChange={(e) => patch({ popiaConsentGiven: e.target.checked })}
            className="mt-1"
          />
          <span>
            The client has consented to the credit provider processing their personal
            information for credit assessment, loan administration, and regulatory
            reporting (POPIA §11).
          </span>
        </label>
        {errors.popiaConsentGiven && (
          <p className="text-xs text-[var(--cf-danger)] mt-1" role="alert">
            {errors.popiaConsentGiven}
          </p>
        )}
        <dl className="mt-3 divide-y divide-[var(--cf-border-subtle)]">
          <Row
            label="POPIA consent"
            value={data.popiaConsentGiven ? "Given" : "Not given"}
          />
        </dl>
      </section>
    </div>
  )
}
