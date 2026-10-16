import Link from "next/link"
import { useState } from "react"
import { ClientPicker } from "@/components/wizard/ClientPicker"
import type { Client } from "@/components/wizard/types"
import { INVALIDATED_AFFORDABILITY } from "./types"
import type { ApplicationWizardData, WizardMode } from "./types"
import type { ValidationErrors } from "@/lib/validation/application-wizard"

interface StepProps {
  data: ApplicationWizardData
  patch: (partial: Partial<ApplicationWizardData>) => void
  errors: ValidationErrors<ApplicationWizardData>
  // Reserved for portal-mode conditional rendering in Phase 6 (design spec D1).
  // Not consumed today; kept as a deliberate seam so the wizard can branch on
  // staff vs portal context without a future prop-drilling refactor.
  mode: WizardMode
  clients: Client[]
}

export function Step1ClientSelect({ data, patch, errors, clients }: StepProps) {
  const [search, setSearch] = useState("")
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Choose the client</h2>
      {/* The client is an affordability input too: their income, expenses and debt
          produce the NDI the §81 flag is derived from. Switching client from the
          review screen must invalidate the snapshot for the same reason changing
          the amount does — otherwise a PASS earned against a R9,500 NDI rides
          along onto a client with R500. */}
      <ClientPicker
        clients={clients}
        selectedClientId={data.clientId}
        clientSearch={search}
        setClientSearch={setSearch}
        // A PO document is the previous client's: a new client starts without one.
        onSelect={(id) => patch({
          clientId: id,
          ...INVALIDATED_AFFORDABILITY,
          ...(id !== data.clientId ? { poDocumentId: "" } : {}),
        })}
      />
      {errors.clientId && (
        <p className="text-xs text-[var(--cf-danger)]" role="alert">{errors.clientId}</p>
      )}
      <p className="text-xs text-[var(--cf-text-muted)]">
        Not on the list?{" "}
        <Link
          href="/clients/new?return=application"
          className="text-[var(--cf-brand)] hover:text-[var(--cf-brand-alt)]"
        >
          Create a new client
        </Link>
        .
      </p>
    </div>
  )
}
