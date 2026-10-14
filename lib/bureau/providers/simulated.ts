/**
 * The simulated bureau: deterministic, fixture-driven reports for local
 * development, demos and tests. Every report is labelled `simulated` with the
 * guard key "simulated-bureau", so:
 *  - the enquiry itself is refused on a deployed build unless that key is in
 *    SIMULATED_INTEGRATIONS (lib/integrations/simulation-guard.ts), and
 *  - a stored report is refused at approval wherever that policy forbids it
 *    (simulatedBureauBlock in lib/decision/bureau-simulated.ts) — the same
 *    treatment as the Experian dry-run.
 *
 * The scenario is a pure function of the ID number, so one consumer always
 * gets the same report.
 */
import { createHash } from "node:crypto"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { SIGMA_SCORE_MAX, SIGMA_SCORE_MIN } from "@/lib/integrations/experian"
import {
  SIMULATED_FIXTURES,
  SIMULATED_SCENARIOS,
  type SimulatedScenario,
} from "../__fixtures__/simulated-reports"
import { BureauProviderError, type BureauProvider, type BureauReport } from "../types"

export const SIMULATED_BUREAU_ID = "simulated"
export const SIMULATED_BUREAU_GUARD = "simulated-bureau" as const

export function simulatedScenarioFor(idNumber: string): SimulatedScenario {
  const digest = createHash("sha256").update(idNumber.replace(/\s/g, "")).digest()
  return SIMULATED_SCENARIOS[digest[0] % SIMULATED_SCENARIOS.length]
}

export function simulatedReport(scenario: SimulatedScenario): BureauReport {
  const fixture = SIMULATED_FIXTURES[scenario]
  return {
    provider: SIMULATED_BUREAU_ID,
    simulated: true,
    simulationSource: SIMULATED_BUREAU_GUARD,
    score: {
      value: fixture.score,
      band: { min: SIGMA_SCORE_MIN, max: SIGMA_SCORE_MAX },
      riskGrade: fixture.riskGrade,
      unscoreable: fixture.score === null,
      declineReasons: [...fixture.declineReasons],
    },
    deceased: false,
    underDebtReview: fixture.underDebtReview,
    hasJudgement: fixture.hasJudgement,
    hasNotice: fixture.hasNotice,
    defaults: [...fixture.defaults],
    enquiriesLast90Days: fixture.enquiriesLast90Days,
    pepIndicator: false,
    fraudIndicator: false,
    tradelines: fixture.tradelines.map((t) => ({ ...t })),
    statedMonthlyInstalmentCents: null,
    rawSha256: null,
  }
}

export const simulatedBureau: BureauProvider = {
  id: SIMULATED_BUREAU_ID,
  displayName: "Simulated bureau (synthetic data)",
  capabilities: {
    score: { min: SIGMA_SCORE_MIN, max: SIGMA_SCORE_MAX },
    tradelines: true,
    judgements: true,
    defaults: true,
    enquiryCount: true,
    pep: true,
    fraud: true,
    implemented: true,
  },
  credentialFields: [],
  async enquiry(request) {
    try {
      assertSimulationAllowed(SIMULATED_BUREAU_GUARD, true)
    } catch (error) {
      throw new BureauProviderError(
        "SIMULATION_FORBIDDEN",
        error instanceof Error ? error.message : "Simulated bureau reports are not permitted here",
      )
    }
    return simulatedReport(simulatedScenarioFor(request.consumer.idNumber))
  },
}
