import { describe, expect, it } from "vitest"
import {
  resolveExtractedAccountType,
  resolveExtractedBankName,
  storedBankName,
} from "@/lib/kyc/extraction-bank-fields"

describe("storedBankName", () => {
  // The incident: the VLM read "STANDARD BANK" off the statement and the route
  // stored that string, while the staff form stores the SA_BANKS code
  // "STANDARD_BANK". The two are the same bank and a different string, so every
  // re-apply counted as a bank-detail change and un-verified the statement.
  it.each([
    ["STANDARD BANK", "STANDARD_BANK"],
    ["Standard Bank", "STANDARD_BANK"],
    ["FIRSTRAND BANK LIMITED t/a FNB", "FNB"],
    ["Capitec Bank Limited", "CAPITEC"],
    ["absa bank", "ABSA"],
  ])("resolves the printed name %s to the stored code %s", (printed, code) => {
    expect(storedBankName(printed)).toBe(code)
  })

  it("is idempotent on a value the staff form already stored", () => {
    expect(storedBankName("STANDARD_BANK")).toBe("STANDARD_BANK")
    expect(storedBankName(storedBankName("Standard Bank"))).toBe("STANDARD_BANK")
  })

  // A bank outside SA_BANKS has no code to resolve to. Inventing one would put
  // a value in the record that no picker can select and no canonicaliser knows,
  // which is the failure this vocabulary exists to remove.
  it("keeps an unlisted bank exactly as printed", () => {
    expect(storedBankName("Sasfin Bank Limited")).toBe("Sasfin Bank Limited")
  })
})

describe("resolveExtractedBankName", () => {
  // Canonicalising only the EXTRACTED side left the gap this closes: a staging
  // client stores "First National Bank" (the label
  // form), extraction read the same words off the statement, and comparing the
  // canonicalised "FNB" against the raw stored label still read as a bank
  // change — 409 "decision evidence is bound to bankName". Production holds the
  // same spread: CAPITEC (18) and Capitec (5), Capitec Bank Limited (2),
  // Capitec Bank, capitec, Standard Bank, Discovery Bank, African Bank, many on
  // clients with verified statements.
  it.each([
    ["First National Bank", "First National Bank"],
    ["Capitec", "CAPITEC BANK LIMITED"],
    ["CAPITEC", "Capitec Bank"],
    ["Standard Bank", "STANDARD BANK"],
    ["FNB", "FIRSTRAND BANK LIMITED t/a FNB"],
  ])("writes nothing when %s and %s are the same bank", (record, extracted) => {
    // Not "writes the canonical form": rewriting the record to STANDARD_BANK
    // would move the payout tuple and invalidate the statement, which is the
    // whole failure. The record's own string stays exactly as it is.
    expect(resolveExtractedBankName({ extracted, record })).toEqual({ apply: undefined })
  })

  it("applies the extracted bank when the record has none", () => {
    expect(resolveExtractedBankName({ extracted: "Standard Bank", record: null })).toEqual({
      apply: "STANDARD_BANK",
    })
    expect(resolveExtractedBankName({ extracted: "Standard Bank", record: "" })).toEqual({
      apply: "STANDARD_BANK",
    })
  })

  it("applies a genuinely different bank", () => {
    expect(resolveExtractedBankName({ extracted: "Capitec Bank", record: "FNB" })).toEqual({
      apply: "CAPITEC",
    })
  })

  // Neither side resolves to a code, so nothing can say they are one bank.
  // Failing closed here means the statement still corrects the record.
  it("treats two unresolvable spellings as different banks", () => {
    expect(resolveExtractedBankName({
      extracted: "Sasfin Bank Limited",
      record: "Sasfin",
    })).toEqual({ apply: "Sasfin Bank Limited" })
  })

  it("has nothing to decide when extraction produced no bank", () => {
    expect(resolveExtractedBankName({ extracted: undefined, record: "FNB" })).toEqual({
      apply: undefined,
    })
  })
})

describe("resolveExtractedAccountType", () => {
  // Staff-confirmed wins (Hein, 2026-08-28). Capitec and several ABSA products
  // print no account type, so the VLM guesses; a staff member who has read the
  // statement has not. Overwriting their value invalidated a verified statement
  // five times on one file and blocked a disbursement.
  it("does not apply an extracted type over a value the record already holds", () => {
    expect(resolveExtractedAccountType({ extracted: "CHEQUE", record: "SAVINGS" })).toEqual({
      apply: undefined,
      skipped: {
        field: "accountType",
        record: "SAVINGS",
        extracted: "CHEQUE",
        reason: "record_set_by_staff",
      },
    })
  })

  it("applies the extracted type when the record has none", () => {
    expect(resolveExtractedAccountType({ extracted: "SAVINGS", record: null })).toEqual({
      apply: "SAVINGS",
      skipped: undefined,
    })
  })

  // Agreement is not worth reporting, and re-writing the same value is not
  // worth doing: the record already says it.
  it("reports nothing when the record already agrees", () => {
    expect(resolveExtractedAccountType({ extracted: "SAVINGS", record: "SAVINGS" })).toEqual({
      apply: undefined,
      skipped: undefined,
    })
  })

  it("has nothing to decide when extraction produced no type", () => {
    expect(resolveExtractedAccountType({ extracted: undefined, record: "SAVINGS" })).toEqual({
      apply: undefined,
      skipped: undefined,
    })
    expect(resolveExtractedAccountType({ extracted: undefined, record: null })).toEqual({
      apply: undefined,
      skipped: undefined,
    })
  })
})
