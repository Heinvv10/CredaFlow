import { describe, expect, it } from "vitest"
import { SA_BANKS, bankLabel, canonicalBankName, toBankCode } from "@/lib/banks"

describe("SA bank vocabulary", () => {
  // The list and the canonicaliser are two halves of one contract. Adding a
  // bank to SA_BANKS without teaching canonicalBankName would ship a label that
  // nothing can ever match, and toBankCode would return null for the bank's own
  // name — the exact silent-wrongness this module exists to remove.
  it("every listed bank round-trips through the canonicaliser", () => {
    for (const bank of SA_BANKS) {
      expect(canonicalBankName(bank.label), bank.code).toBe(bank.canonical)
      expect(toBankCode(bank.label), bank.code).toBe(bank.code)
      expect(toBankCode(bank.code), bank.code).toBe(bank.code)
    }
  })

  it("covers the banks the disbursement gate can already match", () => {
    // canonicalBankName knows ten banks. The staff form offered eight, so a
    // consumer banking with Bidvest or Investec could be matched against their
    // statement at payout but never recorded in the first place.
    expect(SA_BANKS).toHaveLength(10)
    expect(SA_BANKS.map((b) => b.code)).toContain("BIDVEST_BANK")
    expect(SA_BANKS.map((b) => b.code)).toContain("INVESTEC")
  })

  // Spellings that have been stored on Client.bankName. Each previously
  // matched no <Select> option, so the form rendered its first option and a save rewrote the client's
  // payout bank to ABSA.
  it.each([
    ["Capitec Bank Limited", "CAPITEC"],
    ["Capitec Bank", "CAPITEC"],
    ["capitec", "CAPITEC"],
    ["Discovery Bank", "DISCOVERY_BANK"],
    ["First National Bank", "FNB"],
  ])("resolves the production value %s to %s, never ABSA", (stored, code) => {
    expect(toBankCode(stored)).toBe(code)
    expect(toBankCode(stored)).not.toBe("ABSA")
  })

  // The distinct bankName spellings the VLM extracts from bank statements
  // (ClientDocument.extractionResult). This is the set the disbursement gate
  // must canonicalise for real consumers — invented spellings would prove
  // nothing about it. "GoTyme Bank" is the interesting one: it
  // matches only because canonicalBankName uses substring containment.
  it.each([
    ["FNB", "FNB"],
    ["Capitec Bank Limited", "CAPITEC"],
    ["NEDBANK", "NEDBANK"],
    ["Absa Bank Ltd", "ABSA"],
    ["Standard Bank", "STANDARD_BANK"],
    ["Capitec Bank", "CAPITEC"],
    ["GoTyme Bank", "TYME_BANK"],
    ["Discovery Bank", "DISCOVERY_BANK"],
  ])("resolves the production VLM extraction %s to %s", (extracted, code) => {
    expect(toBankCode(extracted)).toBe(code)
  })

  it.each([
    ["FNB (First National Bank)", "FNB"],
    ["ABSA Bank", "ABSA"],
    ["  Nedbank  ", "NEDBANK"],
    ["STANDARD BANK OF SOUTH AFRICA", "STANDARD_BANK"],
  ])("resolves the portal mandate spelling %s to %s", (stored, code) => {
    expect(toBankCode(stored)).toBe(code)
  })

  // FNB is a DIVISION of FirstRand Bank Limited, so a statement printed under
  // the registered name is an FNB statement. Before an inherited fix this
  // canonicalised to "firstrandbanklimitedtafnb", matched no client, and the
  // payout was refused — on the most common bank in the book. The Postgres twin
  // canonicalBankName was changed in the SAME commit;
  // bank-canonicaliser-parity.integration.test.ts asserts they agree.
  it.each([
    "FIRSTRAND BANK LIMITED t/a FNB",
    "FirstRand Bank Limited",
    "FirstRand Bank Ltd t/a First National Bank",
  ])("resolves the registered name %s to FNB", (stored) => {
    expect(toBankCode(stored)).toBe("FNB")
  })

  // FirstRand also trades as RMB and WesBank. Mapping them to FNB is
  // deliberate: bankName is one of FOUR fields the payout tuple must match, and
  // the account number and branch code carry the real identity, so a broad bank
  // label cannot on its own admit a payout to the wrong account.
  it.each(["FirstRand Bank Limited t/a RMB", "FIRSTRAND BANK LTD t/a WesBank"])(
    "maps the sibling FirstRand division %s to FNB rather than nothing",
    (stored) => {
      expect(toBankCode(stored)).toBe("FNB")
    },
  )

  // FirstRand is NOT a separate picker entry — it is a spelling of FNB. If it
  // ever became its own SA_BANKS row, a client recorded under it would stop
  // matching an FNB statement.
  it("does not add FirstRand as its own bank in the picker", () => {
    expect(SA_BANKS.map((b) => b.code)).not.toContain("FIRSTRAND")
    expect(SA_BANKS.filter((b) => b.canonical === "fnb")).toHaveLength(1)
  })

  // The whole point of returning null rather than a default. A caller must pass
  // this through as undefined so the picker shows its placeholder: "not set" is
  // recoverable, a confidently wrong bank is not.
  it.each([null, undefined, "", "   ", "Sasfin Bank", "Bank of Nowhere"])(
    "returns null for %s rather than falling back to a bank",
    (stored) => {
      expect(toBankCode(stored)).toBeNull()
    },
  )

  it("keeps an unknown bank readable instead of blanking or renaming it", () => {
    expect(bankLabel("Sasfin Bank")).toBe("Sasfin Bank")
    expect(bankLabel("Capitec Bank Limited")).toBe("Capitec")
    expect(bankLabel(null)).toBe("")
  })

  it("still fails closed for two genuinely different banks", () => {
    expect(canonicalBankName("Capitec")).not.toBe(canonicalBankName("ABSA"))
    expect(toBankCode("Capitec")).not.toBe(toBankCode("Nedbank"))
  })

  // An unlisted bank must still match ITSELF across spellings, or a client on
  // one would be undisbursable rather than merely unselectable.
  it("matches two spellings of the same unlisted bank", () => {
    expect(canonicalBankName("Sasfin Bank")).toBe(canonicalBankName("SASFIN BANK"))
  })
})
