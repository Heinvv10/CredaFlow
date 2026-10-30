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

  // The NCA PDFs are pinned byte for byte; their negative form is the original one.
  it("a ZAR statutory PDF prints negatives exactly as it always has", () => {
    expect(formatZarPdf(-5)).toBe("R -0.05")
    expect(formatZarPdf(-123456)).toBe("R -1,234.56")
    expect(formatZarPdf(-0.4)).toBe("R -0.00")
    expect(formatZarPdf(-100000000)).toBe("R -1,000,000.00")
    expect(formatZarPdf(0)).toBe("R 0.00")
  })

  it("while the UI format and the Lesotho PDF lead with the sign", () => {
    expect(formatZAR(-123456)).toBe("-R 1,234.56")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(formatZarPdf(-5)).toBe("-M 0.05")
    expect(formatZarPdf(-123456)).toBe("-M 1,234.56")
  })
})
