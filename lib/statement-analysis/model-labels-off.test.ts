/** Model labelling as shipped: off (the 2026-10-15 gate failed), so nothing is ever queued or asked. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { MODEL_LABELS, needsModelLabels } from "./model-labels"

afterEach(() => vi.unstubAllEnvs())

describe("model labelling as shipped", () => {
  it("is off: no read needs labels, even with a model configured", () => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    expect(MODEL_LABELS.enabled).toBe(false)
    expect(needsModelLabels({ status: "READ", modelCategoriesVersion: null })).toBe(false)
  })
})
