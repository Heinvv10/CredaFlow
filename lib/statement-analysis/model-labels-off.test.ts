/** Model labelling as shipped: off (the 2026-10-15 gate failed), so nothing is ever queued or asked. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementFacts } from "@/lib/credit-checks/load-facts"
import { MODEL_LABELS, needsModelLabels } from "./model-labels"

afterEach(() => vi.unstubAllEnvs())

describe("model labelling as shipped", () => {
  it("is off: no read needs labels, even with a model configured", () => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    expect(MODEL_LABELS.enabled).toBe(false)
    expect(needsModelLabels({ status: "READ", modelCategoriesVersion: null })).toBe(false)
  })

  it("is off for stored labels too: a read that holds labels feeds no figure, flag or export", () => {
    const row = {
      id: "sa-1", status: "READ", method: "TEXT", bank: "CAPITEC", contentSha256: "sha-1", accountHolderName: "T TESTER", accountNumberLast4: "0001",
      periodStart: null, periodEnd: null, openingBalanceCents: null, closingBalanceCents: null, transactions: [], balanceCheck: "PASS",
      authenticity: { signals: [] }, modelCategories: { "SYNTH ZOLA TRADING": "FOOD" }, modelCategoriesVersion: "synthetic-model|labels-p2",
    }
    expect(statementFacts("doc-1", row as never).modelLabels).toBeNull()
  })
})
