import { describe, expect, it } from "vitest"
import { suspensionApplies } from "./suspension"
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "./types"

const policy = (over: Partial<Ifrs9Settings> = {}): Ifrs9Settings => ({ ...DEFAULT_SETTINGS, enabled: true, ...over })

describe("suspensionApplies", () => {
  it("suspends from the DPD threshold (default 90) and not before", () => {
    expect(suspensionApplies(89, 2, policy())).toBe(false)
    expect(suspensionApplies(90, 3, policy())).toBe(true)
  })

  it("keeps suspending a Stage 3 loan whose DPD has fallen, until the stage cures", () => {
    expect(suspensionApplies(0, 3, policy())).toBe(true)
    expect(suspensionApplies(0, 3, policy({ suspendOnStage3: false }))).toBe(false)
    expect(suspensionApplies(0, 2, policy())).toBe(false)
  })

  it("uses the lender's own threshold and can be switched off", () => {
    expect(suspensionApplies(61, 2, policy({ suspensionDpd: 60 }))).toBe(true)
    expect(suspensionApplies(400, 3, policy({ suspensionEnabled: false }))).toBe(false)
  })
})
