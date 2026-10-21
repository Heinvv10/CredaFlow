/**
 * The synthetic valuation guide: never leaves the process. For local
 * development, tests and the demo stacks only. Each read checks the
 * simulation guard at invocation time; refused, it is a ValuationProviderError
 * NOT_CONFIGURED and nothing is read. Its guides are stored `simulated` and
 * labelled wherever their values appear. Rows: ../__fixtures__/synthetic-valuation-guide.ts.
 */
import { createHash } from "node:crypto"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { SYNTHETIC_GUIDE_ROWS } from "../__fixtures__/synthetic-valuation-guide"
import { ValuationProviderError, type ValuationProvider } from "../types"

function guard(): void {
  try {
    assertSimulationAllowed("simulated-valuation-guide", true)
  } catch (error) {
    throw new ValuationProviderError("NOT_CONFIGURED", error instanceof Error ? error.message : "Simulation refused")
  }
}

export const syntheticValuationProvider: ValuationProvider = {
  id: "synthetic",
  label: "Synthetic guide (simulated)",
  simulated: true,
  assertUsable: guard,
  async readGuide({ effectiveOn }) {
    guard()
    const rows = SYNTHETIC_GUIDE_ROWS.map((row, i) => ({ lineNumber: i + 2, ...row }))
    // One "file" per effective date: the same synthetic guide may be loaded for another month.
    const sha256 = createHash("sha256").update(JSON.stringify({ effectiveOn, rows })).digest("hex")
    return { ok: true, rows, sha256 }
  },
}
