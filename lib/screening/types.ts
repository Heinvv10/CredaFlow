/**
 * Provider-agnostic PEP / sanctions / adverse-media screening.
 * No provider-specific names or fields may appear in this file: an adapter
 * translates its vendor's wire format into these types (the pattern of
 * lib/integrations/collections/types.ts).
 */
import type { ScreeningResult, ScreeningType } from "@prisma/client"

export type { ScreeningResult, ScreeningType }

export const SCREENING_TYPES: readonly ScreeningType[] = ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]

/** What is screened: a client (natural person) or a business entity. */
export type SubjectRef = { clientId: string } | { entityId: string }

/** The subject as sent to a provider. Only what a list match needs. */
export type ScreeningSubject =
  | { kind: "PERSON"; clientId: string; firstName: string; lastName: string; idNumber: string; dateOfBirth: string | null }
  | { kind: "ENTITY"; entityId: string; entityType: string; legalName: string; registrationNumber: string }

/** One list entry the provider matched the subject against. */
export interface ScreeningMatch {
  /**
   * The provider's stable id for the list entry: the carry-forward key. A
   * match without one is never carried; it is referred every time.
   */
  listEntryId: string
  /** The list or entry version, when the provider gives one; part of the carry key. */
  listVersion?: string | null
  listName: string
  matchedName: string
  /** 0..100, as the provider reports it; null when it reports none. */
  score: number | null
  detail: string | null
}

export interface ScreeningTypeResult {
  type: ScreeningType
  result: Exclude<ScreeningResult, "ERROR">
  matches: ScreeningMatch[]
}

export interface ScreeningProviderResult {
  results: ScreeningTypeResult[]
  providerReference: string | null
  /** Synthetic outcome. Never evidence where this deployment forbids simulation. */
  simulated?: true
}

export type ScreeningProviderErrorCode =
  | "UNKNOWN_PROVIDER"
  | "NOT_CONFIGURED"
  | "SIMULATION_FORBIDDEN"
  | "TIMEOUT"
  | "PROVIDER_ERROR"

export class ScreeningProviderError extends Error {
  constructor(
    public readonly code: ScreeningProviderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ScreeningProviderError"
  }
}

export interface ScreeningProvider {
  /** Registry key, stored in TenantConfig.screeningProvider and ScreeningCheck.provider. */
  readonly id: string
  readonly label: string
  readonly simulated: boolean
  /**
   * The types this provider screens. A run records exactly these; a type it
   * does not screen is not "missing" (lib/screening/state.ts).
   */
  readonly supportedTypes: readonly ScreeningType[]
  /**
   * Screens one subject for the requested types. Throws ScreeningProviderError.
   * Must stop when `signal` aborts (the run's timeout, lib/screening/policy.ts).
   */
  screen(subject: ScreeningSubject, types: readonly ScreeningType[], opts: { signal: AbortSignal }): Promise<ScreeningProviderResult>
}
