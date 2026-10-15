import type { RecoveryRoute, ValuationSource } from "@prisma/client"
import { randsToCents } from "@/lib/asset-finance/money-input"

// Form-to-request mapping of the recovery panel's valuation and record-recovery forms.

export interface ValuationForm { valuedOn: string; source: ValuationSource; valuerName: string; amount: string }

export const emptyValuationForm = (today: string): ValuationForm => ({ valuedOn: today, source: "ASSESSOR", valuerName: "", amount: "" })

export type Built<T> = { error: string } | { body: T }

/** The valuation body (POST .../recoveries/[id]/valuation, or .../surrenders/[id]/valuation for an s127 recovery). */
export function valuationBody(form: ValuationForm): Built<Record<string, unknown>> {
  const amountCents = randsToCents(form.amount)
  if (!form.valuedOn) return { error: "Choose the date of the valuation" }
  if (!form.valuerName.trim()) return { error: "Enter the valuer's name" }
  if (amountCents === null || amountCents <= 0) return { error: "Enter the valuation in rand, e.g. 850000.00" }
  return { body: { valuedOn: form.valuedOn, source: form.source, valuerName: form.valuerName.trim(), amountCents } }
}

export interface RecordRecoveryForm { recoveredOn: string; location: string; condition: string; surrenderRequestId: string; meterReading: string }

export const emptyRecordForm = (today: string): RecordRecoveryForm => ({ recoveredOn: today, location: "", condition: "", surrenderRequestId: "", meterReading: "" })

/**
 * The body that opens a recovery: a non-NCA voluntary hand-over, or an NCA
 * s127 recovery from a surrender (the only routes opened here; s131 and court
 * orders come from the legal matter's ASSET_RECOVERED step). A lease may carry
 * an inspection meter reading.
 */
export function recordRecoveryBody(route: RecoveryRoute, form: RecordRecoveryForm): Built<Record<string, unknown>> {
  if (!form.recoveredOn) return { error: "Choose the date the asset was recovered" }
  if (form.location.trim().length < 2) return { error: "Describe the yard or location" }
  if (form.condition.trim().length < 3) return { error: "Describe the condition of the asset" }
  if (route === "NCA_S127_SURRENDER" && !form.surrenderRequestId) return { error: "Choose the surrender this recovery follows" }
  const body: Record<string, unknown> = { route, recoveredOn: form.recoveredOn, location: form.location.trim(), condition: form.condition.trim() }
  if (route === "NCA_S127_SURRENDER") body.surrenderRequestId = form.surrenderRequestId
  const reading = form.meterReading.replace(/[\s,]/g, "")
  if (reading) {
    if (!/^\d+$/.test(reading) || !Number.isSafeInteger(Number(reading))) return { error: "Enter the meter reading as a whole number" }
    body.meterReading = { value: Number(reading) }
  }
  return { body }
}
