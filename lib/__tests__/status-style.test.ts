import { describe, expect, it } from "vitest"
import { formatStatusLabel, getStatusTone } from "../status-style"

// Every LoanStatus value (prisma/schema.prisma) except RESTRUCTURED, whose
// tone mapping is a deferred product decision — see loans/[id]/page.tsx's
// local loanStatusTone map, which still owns that one.
const LOAN_STATUSES = ["ACTIVE", "COMPLETED", "DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF", "CANCELLED"]

describe("getStatusTone", () => {
  it("maps loan and application statuses to stable tones", () => {
    expect(getStatusTone("APPROVED")).toBe("success")
    expect(getStatusTone("ACTIVE")).toBe("success")
    expect(getStatusTone("UNDER_REVIEW")).toBe("warning")
    expect(getStatusTone("SUBMITTED")).toBe("info")
    expect(getStatusTone("DEFAULTED")).toBe("danger")
    expect(getStatusTone("WRITTEN_OFF")).toBe("danger")
    expect(getStatusTone("PENDING_WRITE_OFF")).toBe("warning")
  })

  it("uses neutral for unknown or empty statuses", () => {
    expect(getStatusTone("")).toBe("neutral")
    expect(getStatusTone("UNEXPECTED_STATUS")).toBe("neutral")
  })

  it("assigns every LoanStatus value a non-neutral tone", () => {
    for (const status of LOAN_STATUSES) {
      expect(getStatusTone(status)).not.toBe("neutral")
    }
  })
})

describe("formatStatusLabel", () => {
  it("replaces every underscore, not just the first", () => {
    expect(formatStatusLabel("PENDING_WRITE_OFF")).toBe("PENDING WRITE OFF")
    expect(formatStatusLabel("WRITTEN_OFF")).toBe("WRITTEN OFF")
    expect(formatStatusLabel("ACTIVE")).toBe("ACTIVE")
  })

  it("produces no underscores for any LoanStatus value", () => {
    for (const status of LOAN_STATUSES) {
      expect(formatStatusLabel(status)).not.toMatch(/_/)
    }
  })
})
