// The staff lease panel's forms → the bodies of the lease routes
// (app/api/asset-finance/leases/[loanId]/...). Pure and client-safe. Rands are
// converted with string arithmetic (./money-input.ts); a malformed field comes
// back as `{ error }` for the form to show before anything is sent.
import { randsToCents } from "./money-input"

export type Built = { body: Record<string, unknown> } | { error: string }

const WHOLE = /^\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** POST .../readings: `{ readingDate, value }`. */
export function readingBody(input: { readingDate: string; value: string }): Built {
  if (!DATE.test(input.readingDate)) return { error: "Choose the reading date" }
  if (!WHOLE.test(input.value.trim())) return { error: "The reading is a whole number of hours or km" }
  return { body: { readingDate: input.readingDate, value: Number(input.value.trim()) } }
}

/** POST .../claims: the provider, the provider's invoice filed on the deal, the amount ex VAT and the work. */
export function claimBody(input: { supplierId: string; documentId: string; amountRands: string; description: string; meterReadingId: string }): Built {
  if (input.supplierId === "") return { error: "Choose the provider" }
  if (input.documentId === "") return { error: "Choose the provider's invoice (file it on the deal first)" }
  const amount = randsToCents(input.amountRands)
  if (amount === null || amount < 1) return { error: "The amount is in rand ex VAT, e.g. 4500.00" }
  if (input.description.trim().length < 3) return { error: "Describe the work claimed" }
  return {
    body: {
      supplierId: input.supplierId, providerInvoiceDocumentId: input.documentId, amountExclVatCents: amount, description: input.description.trim(),
      ...(input.meterReadingId === "" ? {} : { meterReadingId: input.meterReadingId }),
    },
  }
}

/** POST .../end-of-term/elect: RETURN or EXTEND alone; PURCHASE with a price ex VAT and the valuation it rests on. */
export function electionBody(input: { outcome: "RETURN" | "EXTEND" | "PURCHASE"; valuationId: string; priceRands: string }): Built {
  if (input.outcome !== "PURCHASE") return { body: { outcome: input.outcome } }
  if (input.valuationId === "") return { error: "A purchase rests on a recent valuation of the asset" }
  const price = randsToCents(input.priceRands)
  if (price === null || price < 1) return { error: "The price is in rand ex VAT, e.g. 250000.00" }
  return { body: { outcome: "PURCHASE", purchasePriceExclVatCents: price, valuationId: input.valuationId } }
}

export interface DamageLine {
  description: string
  amountRands: string
}

/** POST .../end-of-term/inspection. A blank damage line is dropped; a half-filled one is an error. */
export function inspectionBody(input: {
  inspectedOn: string
  condition: string
  finalReading: string
  usageContracted: boolean
  damage: DamageLine[]
}): Built {
  if (!DATE.test(input.inspectedOn)) return { error: "Choose the inspection date" }
  if (input.condition.trim().length < 3) return { error: "Describe the asset's condition" }
  const body: Record<string, unknown> = { inspectedOn: input.inspectedOn, condition: input.condition.trim() }
  if (input.usageContracted || input.finalReading.trim() !== "") {
    if (!WHOLE.test(input.finalReading.trim())) return { error: "Record the final meter reading as a whole number: the lease has contracted usage" }
    body.finalReading = Number(input.finalReading.trim())
  }
  const damage: Array<{ description: string; amountExclVatCents: number }> = []
  for (const line of input.damage) {
    if (line.description.trim() === "" && line.amountRands.trim() === "") continue
    const cents = randsToCents(line.amountRands)
    if (line.description.trim().length < 3 || cents === null || cents < 1) return { error: "Each damage item needs a description and a positive amount in rand ex VAT" }
    damage.push({ description: line.description.trim(), amountExclVatCents: cents })
  }
  body.damage = damage
  return { body }
}
