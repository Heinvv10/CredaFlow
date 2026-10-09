export type LeadConversionState = "OPEN" | "STRANDED" | "INCOMPLETE" | "COMPLETE"

/**
 * A completed conversion owns both its exact client and exact application.
 * Legacy rows that have only one link are recoverable but must never be shown
 * as complete or allowed to create a second client/application silently.
 */
export function leadConversionState(
  status: string,
  convertedToClientId: string | null | undefined,
  convertedToApplicationId: string | null | undefined,
  conversionRecoveryRequired = false,
): LeadConversionState {
  if (conversionRecoveryRequired) {
    return convertedToClientId || convertedToApplicationId ? "INCOMPLETE" : "STRANDED"
  }
  if (convertedToClientId && convertedToApplicationId) {
    return status === "CONVERTED" ? "COMPLETE" : "INCOMPLETE"
  }
  if (convertedToClientId || convertedToApplicationId) return "INCOMPLETE"
  if (status === "CONVERTED") return "STRANDED"
  return "OPEN"
}

export function canConvertLead(
  status: string,
  convertedToClientId: string | null | undefined,
  convertedToApplicationId: string | null | undefined,
  conversionRecoveryRequired = false,
): boolean {
  return leadConversionState(
    status,
    convertedToClientId,
    convertedToApplicationId,
    conversionRecoveryRequired,
  ) === "OPEN"
}

/**
 * The CRM presentation status. Recovery rows retain CONVERTED in the database
 * so ordinary pipeline writers cannot reopen them, but must never be counted
 * or displayed as completed conversions.
 */
export function leadPipelineStatus(
  status: string,
  convertedToClientId: string | null | undefined,
  convertedToApplicationId: string | null | undefined,
  conversionRecoveryRequired = false,
): string {
  const state = leadConversionState(
    status,
    convertedToClientId,
    convertedToApplicationId,
    conversionRecoveryRequired,
  )
  if (state === "COMPLETE") return "CONVERTED"
  if (state === "INCOMPLETE" || state === "STRANDED") return state
  return status
}
