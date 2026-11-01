import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock("./load-facts", () => ({ loadDecisionFacts: (...a: unknown[]) => h.load(...a) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { facts } from "./facts.test-helpers"
import { simulateRuleSet } from "./simulate"

const now = new Date("2026-10-30T10:00:00.000Z")
const rules = [{ id: "low", name: "Score below 560", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 560 } }]
const db = {
  loanApplication: { findMany: vi.fn(async () => [{ id: "a1", productId: "prod_1", status: "UNDER_REVIEW", submittedAt: now }]) },
  decisionRuleSetVersion: { findMany: vi.fn(async () => [{ id: "v1", scopeKey: "ALL", version: 1, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), challengerOnly: false, rules, scorecard: null }]) },
  autoDecisionRun: { findMany: vi.fn(async () => []) },
}
const replay = (disclosureRegime: string) => {
  h.load.mockResolvedValue({ facts: facts({ bureauScore: null }), application: { disclosureRegime }, bureauCheckId: null, affordabilitySource: "SNAPSHOT" })
  return simulateRuleSet({ tenantId: "t1", candidate: { productId: null, rules, scorecard: null }, now }, db as never)
}

describe("simulateRuleSet replays what the live run would do", () => {
  beforeEach(() => h.load.mockReset())

  it("refers a key-facts application nobody bureau-checked, for the live set and the candidate, as the engine does", async () => {
    expect(await replay("KEY_FACTS")).toMatchObject({ live: { APPROVE: 0, REFER: 1 }, candidate: { APPROVE: 0, REFER: 1 } })
  })

  it("leaves an NCA_PASQ application to the rules", async () => {
    expect(await replay("NCA_PASQ")).toMatchObject({ live: { APPROVE: 1, REFER: 0 }, candidate: { APPROVE: 1, REFER: 0 } })
  })
})
