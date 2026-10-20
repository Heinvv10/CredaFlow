// The new-deal wizard's data: what the dealer captured before (from the page)
// and what this session picked or captured.
import type { BusinessEntityType } from "@prisma/client"
import { randsToCents } from "@/lib/asset-finance/money-input"

export type DealerEntityOption = {
  id: string
  type: BusinessEntityType
  legalName: string
  registrationNumber: string
  people: { id: string; name: string; roles: string[] }[]
  lenderAddedPeople: number
}

export type DealerWizardOptions = {
  entities: DealerEntityOption[]
  people: { id: string; name: string }[]
  assets: { id: string; label: string }[]
  suppliers: { id: string; name: string }[]
  defaultSupplierId: string | null
  products: { id: string; name: string }[]
  vatRateTenThousandths: number
}

export type BorrowerChoice = { kind: "ENTITY"; entityId: string; entityType: BusinessEntityType } | { kind: "CLIENT"; clientId: string }

/** Rand text → cents for a body; blank → undefined, bad text → an error message. */
export function optionalCents(text: string): { cents?: number; error?: string } {
  if (text.trim() === "") return {}
  const cents = randsToCents(text)
  return cents === null ? { error: "An amount in rand, e.g. 250000.00" } : { cents }
}
