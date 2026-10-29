import { describe, expect, it } from "vitest"
import { suspensionApplies } from "./suspension"
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "./types"

const policy = (over: Partial<Ifrs9Settings> = {}): Ifrs9Settings => ({ ...DEFAULT_SETTINGS, enabled: true, ...over })

describe("suspensionApplies", () => {
  it("suspends every Stage 3 loan by default, including one whose days past due have fallen (probation)", () => {
    expect(suspensionApplies(95, 3, "LOAN", policy())).toBe(true)
    expect(suspensionApplies(0, 3, "LOAN", policy())).toBe(true)
  })

  it("never suspends a Stage 1 or 2 loan, whatever its days past due", () => {
    expect(suspensionApplies(0, 2, "LOAN", policy())).toBe(false)
    expect(suspensionApplies(89, 2, "LOAN", policy())).toBe(false)
    expect(suspensionApplies(500, 2, "LOAN", policy({ suspensionDpd: 90 }))).toBe(false)
    expect(suspensionApplies(0, 1, "LOAN", policy())).toBe(false)
  })

  it("with suspendOnStage3 off, narrows Stage 3 to the DPD threshold: 89 days is not suspended, 90 is", () => {
    const narrow = policy({ suspendOnStage3: false, suspensionDpd: 90 })
    expect(suspensionApplies(89, 3, "LOAN", narrow)).toBe(false)
    expect(suspensionApplies(90, 3, "LOAN", narrow)).toBe(true)
    expect(suspensionApplies(120, 3, "LOAN", policy({ suspendOnStage3: false, suspensionDpd: 120 }))).toBe(true)
    expect(suspensionApplies(119, 3, "LOAN", policy({ suspendOnStage3: false, suspensionDpd: 120 }))).toBe(false)
  })

  it("can be switched off, and does not apply to a contract type whose suspense is not journalled", () => {
    expect(suspensionApplies(400, 3, "LOAN", policy({ suspensionEnabled: false }))).toBe(false)
    expect(suspensionApplies(400, 3, "INSTALMENT_SALE", policy())).toBe(false)
    expect(suspensionApplies(400, 3, "FINANCE_LEASE", policy())).toBe(false)
  })
})
