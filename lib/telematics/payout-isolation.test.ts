import { describe, expect, it } from "vitest"
import { closure, sourceFiles } from "./__fixtures__/import-graph"

// A live tracker heartbeat never completes the payout checklist's tracker item
// (docs/asset-finance/SLICE5.md part B): the payout modules, and what they
// import, read nothing from lib/telematics. The heartbeat reaches the deal
// page beside the item, not the checklist. The real-DB proof is
// lib/telematics/tracker-certificate.integration.test.ts.
describe("the payout checklist does not depend on telematics", () => {
  const payout = sourceFiles("lib/asset-finance").filter((file) => /\/payout[^/]*\.ts$/.test(file))
  const graph = closure(payout)

  it("finds the payout modules", () => {
    for (const file of ["lib/asset-finance/payout-checklist.ts", "lib/asset-finance/payout-checklist-store.ts", "lib/asset-finance/payout-view.ts"]) {
      expect(payout).toContain(file)
    }
  })

  it("imports no telematics module, directly or transitively", () => {
    expect([...graph].filter((file) => file.startsWith("lib/telematics/"))).toEqual([])
  })
})
