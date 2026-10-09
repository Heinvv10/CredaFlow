import { describe, expect, it } from "vitest"
import {
  DEBT_ACCOUNT_TYPES,
  DEBT_ACCOUNT_TYPE_VALUES,
  debtAccountTypeLabel,
  normaliseDebtAccountType,
  preserveOriginalDebtAccountType,
  captureOriginalDebtAccountTypes,
} from "./debt-account-types"

describe("normaliseDebtAccountType", () => {
  // Three vocabularies were live in this one free-text column at once
  // ("other", "personal_loan", "OTHER", "credit_card", "store_card",
  // "CREDIT_CARD"), and a fourth — the Title Case
  // set — was written into the application's debt snapshot by the affordability
  // panel. Every one of them has to fold to the same canonical value or the
  // selects keep disagreeing about what the consumer declared.
  it.each([
    ["HOME_LOAN", "HOME_LOAN"],
    ["Home Loan", "HOME_LOAN"],
    ["home_loan", "HOME_LOAN"],
    ["Personal Loan", "PERSONAL_LOAN"],
    ["personal_loan", "PERSONAL_LOAN"],
    ["Credit Card", "CREDIT_CARD"],
    ["credit_card", "CREDIT_CARD"],
    ["CREDIT_CARD", "CREDIT_CARD"],
    ["Other", "OTHER"],
    ["other", "OTHER"],
    ["OTHER", "OTHER"],
    ["Microfinance", "MICROFINANCE"],
    ["Clothing Account", "CLOTHING_ACCOUNT"],
    ["Vehicle Finance", "VEHICLE_FINANCE"],
  ])("folds %s to %s", (raw, expected) => {
    expect(normaliseDebtAccountType(raw)).toBe(expected)
  })

  // These two do not fold by case/space rules alone — they are renames, so they
  // need explicit aliases or they silently become unrecognised.
  it("maps the legacy 'vehicle' value onto vehicle finance", () => {
    expect(normaliseDebtAccountType("vehicle")).toBe("VEHICLE_FINANCE")
  })

  it("maps the legacy 'store_card' value onto store account", () => {
    expect(normaliseDebtAccountType("store_card")).toBe("STORE_ACCOUNT")
  })

  it("tolerates surrounding whitespace", () => {
    expect(normaliseDebtAccountType("  personal_loan  ")).toBe("PERSONAL_LOAN")
  })

  // Never coerce an unknown value to OTHER. "Other" is a declaration the
  // consumer made; inventing it for a value we failed to parse would put a
  // fabricated answer into NCA s.81 affordability evidence.
  it.each([["", null], ["   ", null], ["BOAT_FINANCE", null], [null, null], [undefined, null]])(
    "returns null rather than guessing for %s",
    (raw, expected) => {
      expect(normaliseDebtAccountType(raw)).toBe(expected)
    },
  )

  it("normalises every canonical value to itself", () => {
    for (const { value } of DEBT_ACCOUNT_TYPES) {
      expect(normaliseDebtAccountType(value)).toBe(value)
    }
  })

  it("exposes a value set matching the option list", () => {
    expect(DEBT_ACCOUNT_TYPE_VALUES).toEqual(new Set(DEBT_ACCOUNT_TYPES.map((t) => t.value)))
  })
})

describe("debtAccountTypeLabel", () => {
  it("labels a canonical value", () => {
    expect(debtAccountTypeLabel("MICROFINANCE")).toBe("Microfinance")
  })

  it("labels a legacy value through the normaliser", () => {
    expect(debtAccountTypeLabel("personal_loan")).toBe("Personal loan")
  })

  // The whole defect was a select silently showing option[0] for a value it
  // could not match, so staff read "Home Loan" where the record said
  // personal_loan. An unrecognised value must be visibly unrecognised.
  it("marks an unrecognised value rather than falling back to the first option", () => {
    expect(debtAccountTypeLabel("BOAT_FINANCE")).toBe("Unrecognised (BOAT_FINANCE)")
  })
})

describe("preserveOriginalDebtAccountType", () => {
  // The stored string feeds affordabilityDebtPayload → decisionFingerprint,
  // which is re-checked against the locked approval snapshot at agreement
  // generation, signing AND disbursement. Canonicalising a row on save is a
  // semantically null edit that would invalidate that snapshot and block
  // payout on a live loan. Same meaning must round-trip byte-identical.
  it("keeps the original bytes when the meaning is unchanged", () => {
    expect(preserveOriginalDebtAccountType("PERSONAL_LOAN", "personal_loan")).toBe("personal_loan")
    expect(preserveOriginalDebtAccountType("OTHER", "other")).toBe("other")
    expect(preserveOriginalDebtAccountType("HOME_LOAN", "Home Loan")).toBe("Home Loan")
    expect(preserveOriginalDebtAccountType("STORE_ACCOUNT", "store_card")).toBe("store_card")
  })

  it("writes the chosen value when the consumer actually changed the type", () => {
    expect(preserveOriginalDebtAccountType("CREDIT_CARD", "personal_loan")).toBe("CREDIT_CARD")
    expect(preserveOriginalDebtAccountType("HOME_LOAN", "other")).toBe("HOME_LOAN")
  })

  it("writes the chosen value for a new row with no original", () => {
    expect(preserveOriginalDebtAccountType("PERSONAL_LOAN", null)).toBe("PERSONAL_LOAN")
    expect(preserveOriginalDebtAccountType("PERSONAL_LOAN", undefined)).toBe("PERSONAL_LOAN")
  })

  // Two unrecognised values both normalise to null. Treating that as "equal"
  // would pin an unparseable string in place forever, defeating the staff
  // correction the Unrecognised label exists to prompt.
  it("does not preserve an unrecognised original just because both fail to parse", () => {
    expect(preserveOriginalDebtAccountType("BOAT_FINANCE", "YACHT_LOAN")).toBe("BOAT_FINANCE")
    expect(preserveOriginalDebtAccountType("OTHER", "BOAT_FINANCE")).toBe("OTHER")
  })
})

describe("captureOriginalDebtAccountTypes", () => {
  // The first version of this keyed originals by ARRAY POSITION. Removing a row
  // shifts every later index, so the row that moved into slot N was compared
  // against the ORIGINAL of the row that used to be there — writing another
  // debt's stored bytes onto it, and moving the approval fingerprint that
  // preserving those bytes exists to protect.
  it("keys by row identity, not position", () => {
    const originals = captureOriginalDebtAccountTypes([
      { key: "row-a", type: "personal_loan" },
      { key: "row-b", type: "credit_card" },
    ])

    // Row A is removed; row B is now at index 0. Looking B up by its identity
    // must still return B's own original, not A's.
    expect(originals.get("row-b")).toBe("credit_card")
    expect(preserveOriginalDebtAccountType("CREDIT_CARD", originals.get("row-b")))
      .toBe("credit_card")
    // The positional bug: B at index 0 would have read A's "personal_loan"
    // and, on a no-op re-pick of CREDIT_CARD, written "CREDIT_CARD" — a
    // fingerprint-moving write. Prove B never sees A's value.
    expect(originals.get("row-b")).not.toBe("personal_loan")
  })

  // A row with no identity is new — it has no stored bytes to preserve, and
  // giving it a synthetic positional key is what let it collide with a real row.
  it("excludes rows with no identity rather than inventing a key", () => {
    const originals = captureOriginalDebtAccountTypes([
      { key: null, type: "personal_loan" },
      { key: undefined, type: "other" },
      { key: "", type: "credit_card" },
      { key: "row-d", type: "home_loan" },
    ])

    expect(originals.size).toBe(1)
    expect(originals.get("row-d")).toBe("home_loan")
    // A new row writes the canonical value — there is nothing to round-trip.
    expect(preserveOriginalDebtAccountType("PERSONAL_LOAN", originals.get("missing")))
      .toBe("PERSONAL_LOAN")
  })

  it("keeps the first occurrence when identities repeat", () => {
    const originals = captureOriginalDebtAccountTypes([
      { key: "dup", type: "personal_loan" },
      { key: "dup", type: "credit_card" },
    ])
    expect(originals.get("dup")).toBe("personal_loan")
  })
})
