import { describe, expect, it } from "vitest"
import { NCA_RULE_IDS } from "./nca-classifier"
import { ncaRefusalReason } from "./deal-submit"
import {
  NCA_REGIME_LABELS,
  NCA_RULE_LABELS,
  bankAccountTypeLabel,
  dealDecisionNote,
  dealFieldLabel,
  describeDecisionReason,
  describeFieldErrors,
  describeSolverError,
  ncaRuleLabel,
  paymentMethodLabel,
  statusLabel,
} from "./labels"
import { dealStatusLabel } from "./deal-labels"

const RAW_ENUM = /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/

describe("NCA rule and regime labels", () => {
  it("labels every rule the classifier returns, in plain English", () => {
    for (const rule of NCA_RULE_IDS) {
      expect(NCA_RULE_LABELS[rule]).toBeTruthy()
      expect(NCA_RULE_LABELS[rule]).not.toMatch(RAW_ENUM)
    }
    expect(Object.keys(NCA_RULE_LABELS).sort()).toEqual([...NCA_RULE_IDS].sort())
  })

  it("states the thresholds the way staff say them", () => {
    expect(ncaRuleLabel("JURISTIC_OVER_THRESHOLD")).toBe("Juristic person over the R1m threshold")
    expect(ncaRuleLabel("LARGE_AGREEMENT")).toBe("Large agreement of R250k or more")
    expect(ncaRuleLabel("TRUST_FEW_NATURAL_TRUSTEES")).toBe("Trust with fewer than 3 trustees, all natural persons")
  })

  it("returns an unknown value unchanged rather than guessing", () => {
    expect(ncaRuleLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW")
  })

  it("labels both regimes", () => {
    expect(NCA_REGIME_LABELS).toEqual({ NCA: "Regulated by the NCA", NON_NCA: "Not regulated by the NCA" })
  })
})

describe("describeDecisionReason", () => {
  it("deal-submit stores a refused NCA deal's reason in plain English; display leaves it as stored", () => {
    // Bound to the real writer: a wording change there goes red here.
    expect(ncaRefusalReason("TRUST_FEW_NATURAL_TRUSTEES")).toBe("NCA applies (Trust with fewer than 3 trustees, all natural persons)")
    expect(ncaRefusalReason(null)).toBe("NCA applies (not classified)")
    expect(describeDecisionReason(ncaRefusalReason("FINANCIALS_UNPROVEN"))).toBe(ncaRefusalReason("FINANCIALS_UNPROVEN"))
  })

  it("replaces rule ids inside any other reason and leaves the rest as recorded", () => {
    expect(describeDecisionReason("Override: JURISTIC_OVER_THRESHOLD confirmed")).toBe(
      "Override: Juristic person over the R1m threshold confirmed",
    )
    expect(describeDecisionReason("DSCR below 1.2")).toBe("DSCR below 1.2")
  })

  it("never leaves a raw rule id for any rule", () => {
    for (const rule of NCA_RULE_IDS) {
      expect(ncaRefusalReason(rule)).not.toMatch(RAW_ENUM)
      expect(describeDecisionReason(ncaRefusalReason(rule))).not.toMatch(RAW_ENUM)
    }
  })
})

describe("status, method and account labels", () => {
  it.each([
    ["APPROVED", "Approved"],
    ["PENDING_APPROVAL", "Pending approval"],
    ["ACTIVE", "Active"],
  ])("statusLabel(%s) = %s", (raw, label) => {
    expect(statusLabel(raw)).toBe(label)
  })

  it("names the refused deal status", () => {
    expect(dealStatusLabel("REFUSED_NCA")).toBe("Refused: NCA applies")
  })

  it.each([
    ["CHEQUE", "Cheque"],
    ["SAVINGS", "Savings"],
    ["TRANSMISSION", "Transmission"],
  ])("bank account type %s = %s", (raw, label) => {
    expect(bankAccountTypeLabel(raw)).toBe(label)
  })

  it.each([
    ["EFT", "EFT"],
    ["DEBIT_ORDER", "Debit order"],
    ["CASH", "Cash"],
    ["WAIVER", "Balance waived"],
  ])("payment method %s = %s", (raw, label) => {
    expect(paymentMethodLabel(raw)).toBe(label)
  })
})

describe("dealDecisionNote", () => {
  it("shows a closed deal's final state instead of asking for a submit", () => {
    expect(dealDecisionNote("REFUSED_NCA")).toMatch(/^Refused: NCA applies/)
    expect(dealDecisionNote("CANCELLED")).toMatch(/^Cancelled/)
    expect(dealDecisionNote("BOOKED")).toBe("Final state: Booked.")
    expect(dealDecisionNote("DECLINED")).toBe("Final state: Declined.")
  })

  it("asks for a submit only on a draft", () => {
    expect(dealDecisionNote("DRAFT")).toBe("Submit the deal to decide it.")
    for (const status of ["SUBMITTED", "REFERRED", "APPROVED", "CONTRACTED", "BOOKED", "REFUSED_NCA", "CANCELLED", "DECLINED"] as const) {
      expect(dealDecisionNote(status)).not.toMatch(/Submit the deal/)
    }
  })
})

describe("deal field names", () => {
  it.each([
    ["balloonCents", "Balloon"],
    ["depositCents", "Deposit"],
    ["preset.periods", "Months"],
    ["weights[3]", "Payment weights"],
    ["vatDeferralPeriods.periodIndex", "VAT repaid in period"],
    ["unknownKey", "unknownKey"],
  ])("%s → %s", (key, label) => {
    expect(dealFieldLabel(key)).toBe(label)
  })

  it("turns an API fields map into sentences", () => {
    expect(describeFieldErrors({ balloonCents: "must be at most 2147483647", firstDueDate: "must be after today" })).toEqual([
      "Balloon must be at most 2147483647",
      "First due date must be after today",
    ])
  })

  it("rewrites a solver message's field prefix and leaves other text", () => {
    expect(describeSolverError("financed amount: must be more than 0")).toBe("Financed amount must be more than 0")
    expect(describeSolverError("firstDueDate: must be after startDate")).toBe("First due date must be after startDate")
    expect(describeSolverError("No PRIME reference rate is recorded on or before 2026-10-13")).toBe(
      "No PRIME reference rate is recorded on or before 2026-10-13",
    )
  })
})
