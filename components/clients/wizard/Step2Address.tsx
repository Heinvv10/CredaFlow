import { FieldGroup } from "@/components/wizard/FieldGroup"
import { INP } from "./constants"
import type { ClientWizardData, WizardMode } from "./types"
import type { ClientWizardErrors } from "@/lib/validation/client-wizard"
import { activeJurisdiction } from "@/lib/jurisdiction/active"
import { LESOTHO_DISTRICTS, LESOTHO_DISTRICT_NAMES } from "@/lib/jurisdiction/phone-region"

interface StepProps {
  data: ClientWizardData
  patch: (partial: Partial<ClientWizardData>) => void
  errors: ClientWizardErrors
  mode: WizardMode
}

const PROVINCES: { code: string; label: string }[] = [
  { code: "EC", label: "Eastern Cape" },
  { code: "FS", label: "Free State" },
  { code: "GP", label: "Gauteng" },
  { code: "KZN", label: "KwaZulu-Natal" },
  { code: "LP", label: "Limpopo" },
  { code: "MP", label: "Mpumalanga" },
  { code: "NC", label: "Northern Cape" },
  { code: "NW", label: "North West" },
  { code: "WC", label: "Western Cape" },
]

const DISTRICTS: { code: string; label: string }[] = LESOTHO_DISTRICTS.map((code) => ({ code, label: LESOTHO_DISTRICT_NAMES[code] }))

export function Step2Address({ data, patch, errors }: StepProps) {
  const lesotho = activeJurisdiction() === "LS"
  const regions = lesotho ? DISTRICTS : PROVINCES
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Residential address</h2>

      <FieldGroup label="Street address (line 1)" error={errors.addressLine1} hint="Optional">
        <input
          className={INP}
          value={data.addressLine1}
          onChange={(e) => patch({ addressLine1: e.target.value })}
          autoComplete="address-line1"
        />
      </FieldGroup>

      <FieldGroup label="Suburb" required error={errors.suburb}>
        <input
          className={INP}
          value={data.suburb}
          onChange={(e) => patch({ suburb: e.target.value })}
          autoComplete="address-level3"
        />
      </FieldGroup>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="City" required error={errors.city}>
          <input
            className={INP}
            value={data.city}
            onChange={(e) => patch({ city: e.target.value })}
            autoComplete="address-level2"
          />
        </FieldGroup>
        <FieldGroup label={lesotho ? "District" : "Province"} required error={errors.province}>
          <select
            className={INP}
            value={data.province}
            onChange={(e) => patch({ province: e.target.value })}
          >
            <option value="">Select…</option>
            {regions.map((p) => (
              <option key={p.code} value={p.code}>{p.label}</option>
            ))}
          </select>
        </FieldGroup>
      </div>

      <FieldGroup label="Postal code" required error={errors.postalCode}>
        <input
          className={INP}
          value={data.postalCode}
          onChange={(e) => patch({ postalCode: e.target.value.replace(/\D/g, "").slice(0, lesotho ? 3 : 4) })}
          inputMode="numeric"
          autoComplete="postal-code"
        />
      </FieldGroup>
    </div>
  )
}
