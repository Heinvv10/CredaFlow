import { describe, it, expect } from "vitest"
import { arrearsBucket, ARREARS_BANDS } from "./arrears-buckets"

describe("arrearsBucket", () => {
  it("puts exactly 90 days in the 90+ band, not 61-89", () => {
    // The defect: three surfaces bucketed `days <= 90` as "61-90 DPD" and
    // started 90+ at 91, so the bucket table disagreed with the PAR90/NPL
    // headline (>= 90) by exactly the loans sitting on day 90.
    expect(arrearsBucket(89)).toBe("61-89 DPD")
    expect(arrearsBucket(90)).toBe("90+ DPD")
    expect(arrearsBucket(91)).toBe("90+ DPD")
  })

  it("places every other boundary in the lower band", () => {
    expect(arrearsBucket(1)).toBe("1-30 DPD")
    expect(arrearsBucket(30)).toBe("1-30 DPD")
    expect(arrearsBucket(31)).toBe("31-60 DPD")
    expect(arrearsBucket(60)).toBe("31-60 DPD")
    expect(arrearsBucket(61)).toBe("61-89 DPD")
  })

  it("assigns every day from 1 to 400 to exactly one band", () => {
    for (let d = 1; d <= 400; d++) {
      const matches = ARREARS_BANDS.filter(
        (b) => d >= b.min && (b.max === null || d <= b.max),
      )
      expect(matches, `day ${d}`).toHaveLength(1)
      expect(arrearsBucket(d)).toBe(matches[0].label)
    }
  })

  it("leaves no gap between consecutive bands", () => {
    for (let i = 0; i < ARREARS_BANDS.length - 1; i++) {
      expect(ARREARS_BANDS[i].max).not.toBeNull()
      expect(ARREARS_BANDS[i + 1].min).toBe((ARREARS_BANDS[i].max as number) + 1)
    }
  })

  it("labels each band with the days it actually contains", () => {
    // The reports overview queried gte:61/lte:89 but labelled it "61-90 DPD".
    for (const band of ARREARS_BANDS) {
      if (band.max === null) {
        expect(band.label).toBe(`${band.min}+ DPD`)
      } else {
        expect(band.label).toBe(`${band.min}-${band.max} DPD`)
      }
    }
  })

  it("keeps the 90+ band open-ended and aligned with PAR90/NPL", () => {
    const last = ARREARS_BANDS[ARREARS_BANDS.length - 1]
    expect(last.min).toBe(90)
    expect(last.max).toBeNull()
  })
})
