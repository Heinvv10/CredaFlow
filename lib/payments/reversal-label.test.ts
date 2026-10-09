import { describe, it, expect } from "vitest"
import { methodLabelWithReversal, reversalDetailLine } from "./reversal-label"

// Fixed formatter so tests don't depend on locale/timezone.
const fmt = (d: Date) => d.toISOString().slice(0, 10)

describe("methodLabelWithReversal", () => {
  it("returns the plain method label for an active payment", () => {
    expect(methodLabelWithReversal("EFT", false)).toBe("EFT")
    expect(methodLabelWithReversal("DEBIT ORDER", undefined)).toBe("DEBIT ORDER")
  })

  it("keeps the original method and appends the reversal marker for a reversed payment", () => {
    // Replacing the method with just "Reversed" would lose the method.
    expect(methodLabelWithReversal("EFT", true)).toBe("EFT / Reversed")
    expect(methodLabelWithReversal("DEBIT ORDER", true)).toBe("DEBIT ORDER / Reversed")
  })
})

describe("reversalDetailLine", () => {
  it("returns null for a non-reversed payment (nothing to footnote)", () => {
    expect(reversalDetailLine({ reversed: false, reversedAt: new Date(), reversalReason: "x" }, fmt)).toBeNull()
    expect(reversalDetailLine({}, fmt)).toBeNull()
  })

  it("surfaces both reversedAt and reversalReason when present", () => {
    expect(
      reversalDetailLine(
        { reversed: true, reversedAt: new Date(Date.UTC(2026, 6, 14)), reversalReason: "Duplicate capture" },
        fmt,
      ),
    ).toBe("Reversed 2026-07-14 — Duplicate capture")
  })

  it("falls back gracefully when reversedAt is missing", () => {
    expect(reversalDetailLine({ reversed: true, reversalReason: "Bank recall" }, fmt)).toBe(
      "Reversed — Bank recall",
    )
  })

  it("omits the reason when it is absent or blank", () => {
    expect(reversalDetailLine({ reversed: true, reversedAt: new Date(Date.UTC(2026, 6, 14)) }, fmt)).toBe(
      "Reversed 2026-07-14",
    )
    expect(
      reversalDetailLine({ reversed: true, reversedAt: new Date(Date.UTC(2026, 6, 14)), reversalReason: "   " }, fmt),
    ).toBe("Reversed 2026-07-14")
  })

  it("returns the bare marker when neither field is present", () => {
    expect(reversalDetailLine({ reversed: true }, fmt)).toBe("Reversed")
  })
})
