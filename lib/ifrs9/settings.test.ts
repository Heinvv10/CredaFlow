import { describe, expect, it } from "vitest"
import { parseSettingsInput, withEffectiveMonth } from "./settings"
import { DEFAULT_SETTINGS } from "./types"

describe("parseSettingsInput", () => {
  it("merges a partial body over the current settings", () => {
    const result = parseSettingsInput({ enabled: true, sicrDpdOver: 20 }, DEFAULT_SETTINGS)
    expect(result).toEqual({ ok: true, settings: { ...DEFAULT_SETTINGS, enabled: true, sicrDpdOver: 20 } })
  })

  it("accepts the stage mapping, the restructure probation and either Stage 3 interest basis", () => {
    expect(parseSettingsInput({ restructuredStage: 3, debtReviewStage: 1, restructuredProbationMonths: 6, stage3InterestBasis: "NET_BASIS" }, DEFAULT_SETTINGS))
      .toMatchObject({ ok: true, settings: { restructuredStage: 3, debtReviewStage: 1, restructuredProbationMonths: 6, stage3InterestBasis: "NET_BASIS" } })
    expect(parseSettingsInput({ defaultDpd: 120, suspensionDpd: 120 }, DEFAULT_SETTINGS).ok).toBe(true)
  })

  it("accepts an effective month or null", () => {
    expect(parseSettingsInput({ effectiveFromMonth: "2026-11" }, DEFAULT_SETTINGS)).toMatchObject({ ok: true, settings: { effectiveFromMonth: "2026-11" } })
    expect(parseSettingsInput({ effectiveFromMonth: null }, { ...DEFAULT_SETTINGS, effectiveFromMonth: "2026-11" })).toMatchObject({ ok: true, settings: { effectiveFromMonth: null } })
  })

  it.each([
    [{ enabled: "yes" }, "enabled"],
    [{ sicrDpdOver: 0 }, "sicrDpdOver"],
    [{ sicrDpdOver: 30.5 }, "sicrDpdOver"],
    [{ defaultDpd: 5000 }, "defaultDpd"],
    [{ sicrDpdOver: 90, defaultDpd: 90 }, "below"],
    [{ stage2ProbationMonths: -1 }, "stage2ProbationMonths"],
    [{ stage3ProbationMonths: 61 }, "stage3ProbationMonths"],
    [{ suspensionDpd: 0 }, "suspensionDpd"],
    [{ effectiveFromMonth: "2026-13" }, "effectiveFromMonth"],
    [{ restructuredIsSicr: true }, "restructuredIsSicr"],
    [{ restructuredStage: 4 }, "restructuredStage"],
    [{ debtReviewStage: 0 }, "debtReviewStage"],
    [{ restructuredProbationMonths: 61 }, "restructuredProbationMonths"],
    [{ stage3InterestBasis: "WHATEVER" }, "stage3InterestBasis"],
    [{ suspensionDpd: 60 }, "suspensionDpd must not be below defaultDpd"],
    [{ defaultDpd: 120 }, "suspensionDpd must not be below defaultDpd"],
    [{ surprise: true }, "surprise"],
    [[], "object"],
  ])("refuses %j", (body, fragment) => {
    const result = parseSettingsInput(body, DEFAULT_SETTINGS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(fragment)
  })
})

describe("withEffectiveMonth", () => {
  const on = { ...DEFAULT_SETTINGS, enabled: true }

  it("starts a newly enabled lender from the current month", () => {
    expect(withEffectiveMonth(on, DEFAULT_SETTINGS, "2026-10-29").effectiveFromMonth).toBe("2026-10")
  })

  it("keeps a month the lender chose, and leaves a lender that is already on, or stays off, alone", () => {
    expect(withEffectiveMonth({ ...on, effectiveFromMonth: "2027-01" }, DEFAULT_SETTINGS, "2026-10-29").effectiveFromMonth).toBe("2027-01")
    expect(withEffectiveMonth(on, on, "2026-10-29").effectiveFromMonth).toBeNull()
    expect(withEffectiveMonth(DEFAULT_SETTINGS, DEFAULT_SETTINGS, "2026-10-29").effectiveFromMonth).toBeNull()
  })
})
