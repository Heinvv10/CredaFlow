import { describe, it, expect } from "vitest"
import {
  COMPLIANCE_TYPE_GROUP,
  COMPLIANCE_TYPE_LABEL,
  TERMINAL_STATUSES,
  isTerminal,
  groupOf,
  labelOf,
  isOverdue,
  isKnownType,
  summariseCompliance,
  LEGACY_EVIDENCE_HOME,
  LEGACY_TYPES,
  legacyEvidenceHome,
} from "./record-types"

const NOW = new Date("2026-08-16T10:00:00Z")
const PAST = new Date("2026-07-01T00:00:00Z")
const FUTURE = new Date("2026-12-01T00:00:00Z")

// Mirrors prisma/schema.prisma's ComplianceType. Kept as a literal list so the
// test fails if the enum grows and the dashboard is not updated — the failure
// the old hardcoded five-type list never produced.
const ALL_TYPES = [
  "AGREEMENT_ARTIFACT",
  "DEBIT_MANDATE_ARTIFACT",
  "DISBURSEMENT_EXCEPTION",
  "FORM_20_PRE_AGREEMENT",
  "SECTION_129_NOTICE",
  "NCR_QUARTERLY_RETURN",
  "FSCA_QUARTERLY_RETURN",
  "POPIA_CONSENT",
  "FAIS_DISCLOSURE",
  "AFFORDABILITY_ASSESSMENT",
  "CREDIT_BUREAU_CHECK",
  "KYC_EXCEPTION",
  "COMPLAINT",
] as const

const ALL_STATUSES = ["PENDING", "COMPLETED", "OVERDUE", "SUBMITTED", "ACKNOWLEDGED"] as const

describe("type coverage", () => {
  it("classifies every ComplianceType", () => {
    expect(Object.keys(COMPLIANCE_TYPE_GROUP).sort()).toEqual([...ALL_TYPES].sort())
  })

  it("labels every ComplianceType", () => {
    expect(Object.keys(COMPLIANCE_TYPE_LABEL).sort()).toEqual([...ALL_TYPES].sort())
    for (const t of ALL_TYPES) expect(labelOf(t)).not.toBe(t)
  })

  it("falls back to the raw type for an unknown value rather than rendering blank", () => {
    expect(labelOf("SOME_FUTURE_TYPE")).toBe("SOME_FUTURE_TYPE")
    expect(groupOf("SOME_FUTURE_TYPE")).toBe("REGISTER")
  })

  it("keeps lifecycle artifacts out of the obligation group", () => {
    // A PENDING credit-bureau check on an abandoned application is not an
    // unmet legal duty; scoring it as one is what produced 59% "At Risk".
    expect(groupOf("CREDIT_BUREAU_CHECK")).toBe("REGISTER")
    expect(groupOf("AGREEMENT_ARTIFACT")).toBe("REGISTER")
    expect(groupOf("DEBIT_MANDATE_ARTIFACT")).toBe("REGISTER")
  })

  it("treats the statutory filings as obligations", () => {
    for (const t of ["NCR_QUARTERLY_RETURN", "FSCA_QUARTERLY_RETURN", "SECTION_129_NOTICE", "FAIS_DISCLOSURE"]) {
      expect(groupOf(t)).toBe("OBLIGATION")
    }
  })

  it("keeps enum values with no system writer out of the obligation group", () => {
    // Nothing in the app writes these to ComplianceRecord; the evidence lives
    // in ConsentRecord, LoanApplication, Complaint and ClientDocument. Scoring
    // them as obligations made the register look emptier than reality, and a
    // hand-entered row (direct DB insert) must not move the score.
    for (const t of ["POPIA_CONSENT", "AFFORDABILITY_ASSESSMENT", "COMPLAINT", "FORM_20_PRE_AGREEMENT"]) {
      expect(groupOf(t)).toBe("LEGACY")
      expect(LEGACY_EVIDENCE_HOME[t as keyof typeof LEGACY_EVIDENCE_HOME]).toMatch(/\S/)
    }
    expect(Object.keys(LEGACY_EVIDENCE_HOME).sort()).toEqual(LEGACY_TYPES.slice().sort())
  })
})

describe("isTerminal", () => {
  it("counts ACKNOWLEDGED as closed", () => {
    // An acknowledged S.129 notice is a discharged duty. Excluding it scored a
    // better outcome worse than a merely completed one.
    expect(isTerminal("ACKNOWLEDGED")).toBe(true)
  })

  it("counts COMPLETED and SUBMITTED as closed and the rest as open", () => {
    expect(TERMINAL_STATUSES).toEqual(["COMPLETED", "SUBMITTED", "ACKNOWLEDGED"])
    const open = ALL_STATUSES.filter((s) => !isTerminal(s))
    expect(open).toEqual(["PENDING", "OVERDUE"])
  })
})

describe("isOverdue", () => {
  it("is true past the deadline while open", () => {
    expect(isOverdue({ type: "POPIA_CONSENT", status: "PENDING", dueDate: PAST }, NOW)).toBe(true)
  })

  it("is true for an explicit OVERDUE status with no deadline", () => {
    expect(isOverdue({ type: "POPIA_CONSENT", status: "OVERDUE", dueDate: null }, NOW)).toBe(true)
  })

  it("is false before the deadline", () => {
    expect(isOverdue({ type: "FAIS_DISCLOSURE", status: "PENDING", dueDate: FUTURE }, NOW)).toBe(false)
  })

  it("is false once terminal, even with a deadline long past", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isOverdue({ type: "POPIA_CONSENT", status, dueDate: PAST }, NOW)).toBe(false)
    }
  })

  it("is false with no deadline at all — such a record can never age into overdue", () => {
    expect(isOverdue({ type: "POPIA_CONSENT", status: "PENDING", dueDate: null }, NOW)).toBe(false)
  })

  it("accepts a serialised date, as arrives from a server component", () => {
    expect(isOverdue({ type: "POPIA_CONSENT", status: "PENDING", dueDate: PAST.toISOString() }, NOW)).toBe(true)
  })
})

describe("summariseCompliance", () => {
  it("scores obligations only, ignoring lifecycle registers", () => {
    const records = [
      { type: "NCR_QUARTERLY_RETURN", status: "SUBMITTED", dueDate: PAST },
      { type: "FAIS_DISCLOSURE", status: "PENDING", dueDate: FUTURE },
      // 100 pending artifacts must not move the score at all.
      ...Array.from({ length: 100 }, () => ({
        type: "CREDIT_BUREAU_CHECK", status: "PENDING", dueDate: null,
      })),
    ]
    const s = summariseCompliance(records, NOW)
    expect(s.total).toBe(2)
    expect(s.complete).toBe(1)
    expect(s.score).toBe(50)
  })

  it("ignores legacy rows when scoring", () => {
    const s = summariseCompliance([
      { type: "NCR_QUARTERLY_RETURN", status: "SUBMITTED", dueDate: PAST },
      { type: "POPIA_CONSENT", status: "PENDING", dueDate: PAST },
    ], NOW)
    expect(s.total).toBe(1)
    expect(s.overdue).toBe(0)
    expect(s.score).toBe(100)
  })

  it("does not drift as loan volume grows", () => {
    const obligations = [{ type: "FAIS_DISCLOSURE", status: "COMPLETED", dueDate: PAST }]
    const artifact = { type: "AGREEMENT_ARTIFACT", status: "PENDING", dueDate: null }
    const small = summariseCompliance([...obligations, artifact], NOW)
    const large = summariseCompliance(
      [...obligations, ...Array.from({ length: 5000 }, () => artifact)],
      NOW,
    )
    expect(small.score).toBe(large.score)
    expect(large.score).toBe(100)
  })

  it("credits ACKNOWLEDGED obligations", () => {
    const s = summariseCompliance(
      [{ type: "SECTION_129_NOTICE", status: "ACKNOWLEDGED", dueDate: PAST }],
      NOW,
    )
    expect(s.score).toBe(100)
    expect(s.complete).toBe(1)
  })

  it("scores 100 with no obligations rather than dividing by zero", () => {
    const s = summariseCompliance([], NOW)
    expect(s.score).toBe(100)
    expect(s.total).toBe(0)
    expect(Number.isNaN(s.score)).toBe(false)
  })

  it("counts open obligations that have no deadline separately from overdue", () => {
    // These can never become overdue, so "0 overdue, all on track" would be a
    // false assurance while any exist.
    const s = summariseCompliance(
      [
        { type: "FAIS_DISCLOSURE", status: "PENDING", dueDate: null },
        { type: "FAIS_DISCLOSURE", status: "PENDING", dueDate: null },
        { type: "SECTION_129_NOTICE", status: "PENDING", dueDate: PAST },
      ],
      NOW,
    )
    expect(s.overdue).toBe(1)
    expect(s.openWithoutDueDate).toBe(2)
  })

  it("reports open exceptions outside the score", () => {
    const s = summariseCompliance(
      [
        { type: "KYC_EXCEPTION", status: "PENDING", dueDate: null },
        { type: "DISBURSEMENT_EXCEPTION", status: "PENDING", dueDate: null },
        { type: "KYC_EXCEPTION", status: "COMPLETED", dueDate: null },
        { type: "FAIS_DISCLOSURE", status: "COMPLETED", dueDate: PAST },
      ],
      NOW,
    )
    expect(s.openExceptions).toBe(2)
    expect(s.score).toBe(100)
    expect(s.total).toBe(1)
  })

  it("never reports an overdue count above the open obligation count", () => {
    const s = summariseCompliance(
      [
        { type: "FAIS_DISCLOSURE", status: "OVERDUE", dueDate: PAST },
        { type: "CREDIT_BUREAU_CHECK", status: "OVERDUE", dueDate: PAST },
      ],
      NOW,
    )
    expect(s.overdue).toBe(1) // the register row is not an obligation
    expect(s.overdue).toBeLessThanOrEqual(s.total - s.complete)
  })
})

describe("prototype-chain safety", () => {
  // `"constructor" in obj` and `obj["toString"]` both resolve through the
  // prototype chain, so a lookup miss returns an inherited member instead of
  // undefined and any `?? fallback` silently never fires. A user-controlled
  // ?type= param reaches these helpers.
  const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]

  it("does not treat an inherited Object member as a known type", () => {
    for (const key of INHERITED) expect(isKnownType(key)).toBe(false)
  })

  it("groups an inherited member as a register, not an Object member", () => {
    for (const key of INHERITED) expect(groupOf(key)).toBe("REGISTER")
  })

  it("labels an inherited member as its raw string", () => {
    for (const key of INHERITED) expect(labelOf(key)).toBe(key)
  })

  it("still recognises every real type", () => {
    for (const t of ALL_TYPES) expect(isKnownType(t)).toBe(true)
  })
})

describe("legacyEvidenceHome", () => {
  it("returns the home for a legacy type and null otherwise", () => {
    expect(legacyEvidenceHome("COMPLAINT")).toBe(LEGACY_EVIDENCE_HOME.COMPLAINT)
    expect(legacyEvidenceHome("FAIS_DISCLOSURE")).toBeNull()
    expect(legacyEvidenceHome("constructor")).toBeNull()
  })
})
