/**
 * Provider-agnostic PEP / sanctions / adverse-media screening.
 * No provider-specific names or fields may appear in this file: an adapter
 * translates its vendor's wire format into these types (the pattern of
 * lib/integrations/collections/types.ts).
 */
import type { ScreeningResult, ScreeningType } from "@prisma/client"

export type { ScreeningResult, ScreeningType }

export const SCREENING_TYPES: readonly ScreeningType[] = ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]

/** The person screened. Only what a list match needs; never bank or income data. */
export interface ScreeningSubject {
  clientId: string
  firstName: string
  lastName: string
  idNumber: string
  dateOfBirth: string | null
}

/** One list entry the provider matched the subject against. */
export interface ScreeningMatch {
  /** The provider's stable id for the list entry; the carry-forward key. */
  listEntryId: string
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
  /** Screens one subject for every requested type. Throws ScreeningProviderError. */
  screen(subject: ScreeningSubject, types: readonly ScreeningType[]): Promise<ScreeningProviderResult>
}
