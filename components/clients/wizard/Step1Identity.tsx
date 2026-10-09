import { FieldGroup } from "@/components/wizard/FieldGroup"
import { DuplicateIdWarning } from "./DuplicateIdWarning"
import { INP } from "./constants"
import type { ClientWizardData, WizardMode } from "./types"
import {
  deriveDobFromSaId,
  deriveGenderFromSaId,
  type ClientWizardErrors,
} from "@/lib/validation/client-wizard"

interface StepProps {
  data: ClientWizardData
  patch: (partial: Partial<ClientWizardData>) => void
  errors: ClientWizardErrors
  mode: WizardMode   // reserved for portal-mode conditional rendering in Phase 6 (per D1)
}

export function Step1Identity({ data, patch, errors, mode }: StepProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Identity</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="First name" required error={errors.firstName}>
          <input
            className={INP}
            value={data.firstName}
            onChange={(e) => patch({ firstName: e.target.value })}
            autoComplete="given-name"
          />
        </FieldGroup>
        <FieldGroup label="Last name" required error={errors.lastName}>
          <input
            className={INP}
            value={data.lastName}
            onChange={(e) => patch({ lastName: e.target.value })}
            autoComplete="family-name"
          />
        </FieldGroup>
      </div>

      <FieldGroup
        label="SA ID number"
        required
        error={errors.idNumber}
        hint="13-digit South African ID. DOB and gender will be derived if matched."
      >
        <input
          className={INP}
          value={data.idNumber}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, "").slice(0, 13)
            const updates: Partial<ClientWizardData> = { idNumber: next }
            if (next.length === 13) {
              const derivedDob = deriveDobFromSaId(next)
              if (derivedDob && !data.dateOfBirth) {
                updates.dateOfBirth = derivedDob
              }
              const derivedGender = deriveGenderFromSaId(next)
              if (derivedGender && !data.gender) {
                updates.gender = derivedGender
              }
            }
            patch(updates)
          }}
          inputMode="numeric"
          autoComplete="off"
        />
        <DuplicateIdWarning idNumber={data.idNumber} enabled={mode === "staff"} />
      </FieldGroup>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Date of birth" required error={errors.dateOfBirth}>
          <input
            type="date"
            className={INP}
            value={data.dateOfBirth}
            onChange={(e) => patch({ dateOfBirth: e.target.value })}
          />
        </FieldGroup>
        <FieldGroup label="Gender" required error={errors.gender}>
          <select
            className={INP}
            value={data.gender}
            onChange={(e) => patch({ gender: e.target.value as ClientWizardData["gender"] })}
          >
            <option value="">Select…</option>
            <option value="MALE">Male</option>
            <option value="FEMALE">Female</option>
            <option value="OTHER">Other</option>
          </select>
        </FieldGroup>
      </div>

      <FieldGroup label="Email" required error={errors.email}>
        <input
          type="email"
          className={INP}
          value={data.email}
          onChange={(e) => patch({ email: e.target.value })}
          autoComplete="email"
        />
      </FieldGroup>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Mobile phone" required error={errors.phone}>
          <input
            type="tel"
            className={INP}
            value={data.phone}
            onChange={(e) => patch({ phone: e.target.value })}
            autoComplete="tel"
          />
        </FieldGroup>
        <FieldGroup
          label="WhatsApp"
          error={errors.whatsapp}
          hint="Optional — leave blank if same as mobile"
        >
          <input
            type="tel"
            className={INP}
            value={data.whatsapp}
            onChange={(e) => patch({ whatsapp: e.target.value })}
          />
        </FieldGroup>
      </div>
    </div>
  )
}
