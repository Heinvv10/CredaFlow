import { FieldGroup } from "@/components/wizard/FieldGroup"
import { LOAN_PURPOSE_OPTIONS } from "@/lib/loan-purpose-categories"
import { PO_FUNDING_PURPOSE, requiresPoFundingFacts } from "@/lib/applications/po-funding"
import { PoFundingWizardFields } from "./PoFundingWizardFields"
import { INP } from "./constants"
import { INVALIDATED_AFFORDABILITY } from "./types"
import type {
  ApplicationProduct,
  ApplicationWizardData,
  WizardMode,
} from "./types"
import type { ValidationErrors } from "@/lib/validation/application-wizard"
import { formatRands } from "@/lib/utils"

interface StepProps {
  data: ApplicationWizardData
  patch: (partial: Partial<ApplicationWizardData>) => void
  errors: ValidationErrors<ApplicationWizardData>
  // Reserved for portal-mode conditional rendering in Phase 6 (design spec D1).
  // Not consumed today; kept as a deliberate seam so the wizard can branch on
  // staff vs portal context without a future prop-drilling refactor.
  mode: WizardMode
  products: ApplicationProduct[]
}

export function Step2LoanParams({ data, patch, errors, products }: StepProps) {
  // PO funding is business credit: the Business purpose only, plus the order.
  const poFunding = requiresPoFundingFacts(products.find((p) => p.id === data.productId)?.productType)
  const purposeOptions = poFunding ? LOAN_PURPOSE_OPTIONS.filter((o) => o.value === PO_FUNDING_PURPOSE) : LOAN_PURPOSE_OPTIONS
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Loan parameters</h2>

      <FieldGroup label="Product" required error={errors.productId}>
        <div className="space-y-2">
          {products.map((p) => (
            <label
              key={p.id}
              className={`block p-3 rounded-lg border cursor-pointer ${
                data.productId === p.id
                  ? "bg-[var(--cf-brand)]/15 border-[var(--cf-brand)]"
                  : "bg-[var(--cf-bg-raised)] border-[var(--cf-border-subtle)]"
              }`}
            >
              <input
                type="radio"
                name="productId"
                value={p.id}
                checked={data.productId === p.id}
                onChange={() => patch({
                  productId: p.id,
                  ...INVALIDATED_AFFORDABILITY,
                  ...(requiresPoFundingFacts(p.productType) ? { loanPurposeCategory: PO_FUNDING_PURPOSE } : {}),
                })}
                className="mr-2"
              />
              <span className="text-sm font-medium text-[var(--cf-text)]">{p.name}</span>
              <span className="ml-2 text-xs text-[var(--cf-text-muted)]">
                {formatRands(p.minAmount)}–{formatRands(p.maxAmount)} · {p.minTermDays}–{p.maxTermDays} days
              </span>
            </label>
          ))}
        </div>
      </FieldGroup>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Applied amount (R)" required error={errors.appliedAmount}>
          <input
            className={INP}
            value={data.appliedAmount}
            onChange={(e) => patch({ appliedAmount: e.target.value, ...INVALIDATED_AFFORDABILITY })}
            inputMode="decimal"
          />
        </FieldGroup>
        <FieldGroup label="Term (days)" required error={errors.appliedTermDays}>
          <input
            className={INP}
            value={data.appliedTermDays}
            onChange={(e) =>
              patch({ appliedTermDays: e.target.value.replace(/\D/g, ""), ...INVALIDATED_AFFORDABILITY })
            }
            inputMode="numeric"
          />
        </FieldGroup>
      </div>

      <FieldGroup label="Purpose category" error={errors.loanPurposeCategory} hint={poFunding ? undefined : "Optional"} required={poFunding}>
        <select
          id="loanPurposeCategory"
          className={INP}
          value={data.loanPurposeCategory}
          onChange={(e) => patch({ loanPurposeCategory: e.target.value })}
        >
          {!poFunding && <option value="">Select…</option>}
          {purposeOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </FieldGroup>

      {poFunding && <PoFundingWizardFields data={data} patch={patch} errors={errors} />}

      <FieldGroup label="Purpose" required error={errors.purpose}>
        <input
          className={INP}
          value={data.purpose}
          onChange={(e) => patch({ purpose: e.target.value })}
        />
      </FieldGroup>

      <FieldGroup label="Details" error={errors.purposeDetails} hint="Optional">
        <textarea
          className={INP}
          rows={3}
          value={data.purposeDetails}
          onChange={(e) => patch({ purposeDetails: e.target.value })}
        />
      </FieldGroup>
    </div>
  )
}
