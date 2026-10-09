type KnownAcceptedDispatchError = Error & {
  outcome: "PROVIDER_ACCEPTED"
  providerAcceptedAt: Date
  providerMessageId?: string
  evidenceReference?: string
  evidenceAuditWriteError?: unknown
}

export type KnownAcceptedDispatchEvidence = {
  acceptedAt: Date
  providerMessageId?: string
  providerEvidenceReference?: string
  persistenceWarning: string
  emergencyAuditPersisted: boolean
}

function nonEmptyEvidence(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length >= 3 && trimmed.length <= 512 && !/[\u0000-\u001F\u007F]/.test(trimmed)
    ? trimmed
    : undefined
}

/**
 * Recover known provider acceptance from the catastrophic post-dispatch error
 * without relying on instanceof across route/test/module boundaries.
 */
export function readKnownAcceptedDispatchEvidence(
  error: unknown,
): KnownAcceptedDispatchEvidence | null {
  if (!(error instanceof Error) || error.name !== "KnownDispatchPersistenceError") return null
  const candidate = error as KnownAcceptedDispatchError
  if (candidate.outcome !== "PROVIDER_ACCEPTED") return null
  if (!(candidate.providerAcceptedAt instanceof Date)) return null
  const acceptedAt = new Date(candidate.providerAcceptedAt)
  if (!Number.isFinite(acceptedAt.getTime())) return null

  const providerMessageId = nonEmptyEvidence(candidate.providerMessageId)
  const providerEvidenceReference = nonEmptyEvidence(candidate.evidenceReference)
  if (!providerMessageId && !providerEvidenceReference) return null

  return {
    acceptedAt,
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(providerEvidenceReference ? { providerEvidenceReference } : {}),
    persistenceWarning: "Provider accepted the notice, but the terminal Message state could not be persisted.",
    emergencyAuditPersisted: candidate.evidenceAuditWriteError === undefined,
  }
}
