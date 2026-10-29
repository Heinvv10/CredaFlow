import { afterEach, describe, expect, it } from "vitest"
import { formatRands, formatZAR, formatZARCompact } from "@/lib/utils"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

afterEach(() => resetActiveJurisdiction())

describe("the money choke points follow the lender's currency", () => {
  it("ZA output is the unchanged rand format", () => {
    expect(formatZAR(123456)).toBe("R 1,234.56")
    expect(formatRands(1000000, { whole: true })).toBe("R 1,000,000")
    expect(formatRands(12.5)).toBe("R 12.50")
    expect(formatZARCompact(250_000_000)).toBe("R2.5m")
    expect(formatZarPdf(123456)).toBe("R 1,234.56")
  })

  it("an LS lender sees Maloti everywhere, PDFs included", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(formatZAR(123456)).toBe("M 1,234.56")
    expect(formatRands(1000000, { whole: true })).toBe("M 1,000,000")
    expect(formatRands(12.5)).toBe("M 12.50")
    expect(formatZARCompact(250_000_000)).toBe("M2.5m")
    expect(formatZarPdf(123456)).toBe("M 1,234.56")
  })
})
