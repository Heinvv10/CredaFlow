import { describe, expect, it } from "vitest"
import { formatDatePdf } from "./helpers"

describe("formatDatePdf", () => {
  it("renders statutory dates in Africa/Johannesburg across a UTC day boundary", () => {
    expect(formatDatePdf(new Date("2026-06-30T22:30:00.000Z"))).toBe("1 July 2026")
  })
})
