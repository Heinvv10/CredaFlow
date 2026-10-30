import { describe, expect, it } from "vitest"
import { formatMoney, formatMoneyCompact, formatMoneyWhole } from "./money"

describe("formatMoney", () => {
  it("ZAR is byte-identical to the house format used since day one", () => {
    expect(formatMoney(123456, "ZAR")).toBe("R 1,234.56")
    expect(formatMoney(0, "ZAR")).toBe("R 0.00")
    expect(formatMoney(5, "ZAR")).toBe("R 0.05")
    expect(formatMoney(-5, "ZAR")).toBe("-R 0.05")
    expect(formatMoney(100000000, "ZAR")).toBe("R 1,000,000.00")
  })

  it("LSL prints Maloti with the M symbol and the same grouping", () => {
    expect(formatMoney(123456, "LSL")).toBe("M 1,234.56")
    expect(formatMoney(99, "LSL")).toBe("M 0.99")
    expect(formatMoney(100000000, "LSL")).toBe("M 1,000,000.00")
  })

  it("whole amounts drop the cents", () => {
    expect(formatMoneyWhole(1000000, "ZAR")).toBe("R 1,000,000")
    expect(formatMoneyWhole(2500.4, "LSL")).toBe("M 2,500")
  })

  it("compact amounts abbreviate from cents, not rands", () => {
    expect(formatMoneyCompact(250_000_000, "ZAR")).toBe("R2.5m")
    expect(formatMoneyCompact(12_300_000, "LSL")).toBe("M123k")
    expect(formatMoneyCompact(99_900, "LSL")).toBe("M 999.00")
  })

  it("negative amounts lead with the sign", () => {
    expect(formatMoney(-123456, "LSL")).toBe("-M 1,234.56")
    expect(formatMoney(-0.4, "ZAR")).toBe("R 0.00")
    expect(formatMoneyWhole(-2500.4, "ZAR")).toBe("-R 2,500")
    expect(formatMoneyCompact(-250_000_000, "ZAR")).toBe("-R2.5m")
    expect(formatMoneyCompact(-12_300_000, "LSL")).toBe("-M123k")
    expect(formatMoneyCompact(-99_900, "LSL")).toBe("-M 999.00")
  })

  it("a figure that rounds up to 1000k is shown in millions", () => {
    expect(formatMoneyCompact(99_950_000, "ZAR")).toBe("R1.0m")
    expect(formatMoneyCompact(99_949_999, "ZAR")).toBe("R999k")
    expect(formatMoneyCompact(100_000_000, "ZAR")).toBe("R1.0m")
  })
})
