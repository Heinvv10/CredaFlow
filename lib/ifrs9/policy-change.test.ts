import { describe, expect, it } from "vitest"
import { policyChangeRefusal, type LedgerPosition } from "./store"
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "./types"

const on = (over: Partial<Ifrs9Settings> = {}): Ifrs9Settings => ({ ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-10", ...over })
const position = (over: Partial<LedgerPosition> = {}): LedgerPosition => ({ allowanceCents: 0, suspenseCents: 0, posted: false, ...over })
const held = position({ allowanceCents: -16_268, posted: true })

describe("policyChangeRefusal", () => {
  it("lets anything change before IFRS 9 has posted", () => {
    expect(policyChangeRefusal(on(), on({ enabled: false }), position())).toBeNull()
    expect(policyChangeRefusal(on(), on({ stage3InterestBasis: "NET_BASIS", effectiveFromMonth: "2027-01" }), position())).toBeNull()
  })

  it("refuses switching off while an allowance is held, or interest in suspense", () => {
    expect(policyChangeRefusal(on(), on({ enabled: false }), held)).toContain("allowance of R162.68")
    expect(policyChangeRefusal(on(), on({ enabled: false }), position({ suspenseCents: -10_000, posted: true }))).toContain("suspense of R100.00")
    expect(policyChangeRefusal(on({ enabled: false }), on({ enabled: false }), held)).toBeNull()
  })

  it("lets it be switched off once both balances are nil", () => {
    expect(policyChangeRefusal(on(), on({ enabled: false }), position({ posted: true }))).toBeNull()
  })

  // Review breaker 5 (PR #255 round 2): moving the first month forward left later months closing on a frozen position.
  it("refuses moving the first month forward while a position is held, but not earlier, and not when nothing is held", () => {
    expect(policyChangeRefusal(on(), on({ effectiveFromMonth: "2027-01" }), held)).toContain("cannot move forward")
    expect(policyChangeRefusal(on({ effectiveFromMonth: null }), on({ effectiveFromMonth: "2027-01" }), held)).toContain("cannot move forward")
    expect(policyChangeRefusal(on(), on({ effectiveFromMonth: "2026-10" }), held)).toBeNull()
    expect(policyChangeRefusal(on({ effectiveFromMonth: "2027-01" }), on({ effectiveFromMonth: "2026-11" }), held)).toBeNull()
    expect(policyChangeRefusal(on(), on({ effectiveFromMonth: "2027-01" }), position({ posted: true }))).toBeNull()
  })

  it("refuses changing the Stage 3 interest basis once anything has been posted, even with nothing held now", () => {
    expect(policyChangeRefusal(on(), on({ stage3InterestBasis: "NET_BASIS" }), position({ posted: true }))).toContain("stage3InterestBasis")
    expect(policyChangeRefusal(on(), on({ stage3InterestBasis: "FULL_SUSPENSION" }), position({ posted: true }))).toBeNull()
  })
})
