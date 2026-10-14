import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import {
  ScreeningProviderError,
  type ScreeningMatch,
  type ScreeningProvider,
  type ScreeningSubject,
  type ScreeningType,
  type ScreeningTypeResult,
} from "./types"

/**
 * Simulated screening provider: fixture outcomes, no vendor call. For local
 * development, tests and demos until a screening provider is contracted.
 *
 * The outcome is chosen by the subject's surname, which must be one of the
 * obviously synthetic fixture names below; every other subject screens clear.
 *
 *   Fixture-Pep       PEP            CONFIRMED_MATCH  (refer; a senior may accept)
 *   Fixture-Sanction  SANCTIONS      CONFIRMED_MATCH  (hard block, never cleared)
 *   Fixture-Possible  SANCTIONS      POSSIBLE_MATCH   (refer; false positive or reject)
 *   Fixture-Media     ADVERSE_MEDIA  CONFIRMED_MATCH  (refer)
 *   Fixture-Error     provider error (screening incomplete)
 *
 * Refused on a deployed build (NODE_ENV=production) unless "screening" is in
 * SIMULATED_INTEGRATIONS (lib/integrations/simulation-guard.ts): a simulated
 * "clear" would otherwise let a sanctioned person through.
 */
export const SIMULATED_SCREENING_PROVIDER_ID = "simulated"

type Fixture = { type: ScreeningType; result: "POSSIBLE_MATCH" | "CONFIRMED_MATCH"; listName: string; score: number }

const FIXTURES: Record<string, Fixture> = {
  "fixture-pep": { type: "PEP", result: "CONFIRMED_MATCH", listName: "Simulated PEP list", score: 97 },
  "fixture-sanction": { type: "SANCTIONS", result: "CONFIRMED_MATCH", listName: "Simulated sanctions list", score: 99 },
  "fixture-possible": { type: "SANCTIONS", result: "POSSIBLE_MATCH", listName: "Simulated sanctions list", score: 71 },
  "fixture-media": { type: "ADVERSE_MEDIA", result: "CONFIRMED_MATCH", listName: "Simulated adverse media", score: 88 },
}

function fixtureMatch(key: string, fixture: Fixture): ScreeningMatch {
  return {
    listEntryId: `SIM-${key.toUpperCase()}-0001`,
    listName: fixture.listName,
    matchedName: "FIXTURE PERSON (synthetic)",
    score: fixture.score,
    detail: "Simulated fixture match — not a real list entry.",
  }
}

export function simulatedOutcome(subject: ScreeningSubject, types: readonly ScreeningType[]): ScreeningTypeResult[] {
  const key = subject.lastName.trim().toLowerCase()
  if (key === "fixture-error") {
    throw new ScreeningProviderError("PROVIDER_ERROR", "Simulated provider error (fixture)")
  }
  const fixture = FIXTURES[key]
  return types.map((type) =>
    fixture && fixture.type === type
      ? { type, result: fixture.result, matches: [fixtureMatch(key, fixture)] }
      : { type, result: "CLEAR", matches: [] },
  )
}

export const simulatedScreeningProvider: ScreeningProvider = {
  id: SIMULATED_SCREENING_PROVIDER_ID,
  label: "Simulated (fixtures, no vendor)",
  simulated: true,
  async screen(subject, types) {
    try {
      assertSimulationAllowed("screening", true)
    } catch (error) {
      throw new ScreeningProviderError(
        "SIMULATION_FORBIDDEN",
        error instanceof Error ? error.message : "Simulated screening is not permitted on this deployment",
      )
    }
    return {
      results: simulatedOutcome(subject, types),
      providerReference: `SIM-${subject.clientId}`,
      simulated: true,
    }
  },
}
