import { describe, expect, it } from "vitest"
import { checkFigures, checkNoContradiction, type Allowed } from "./post-check"

const allowed: Allowed = {
  amountsCents: [123_456, 850_000, 12_500_00, -45_000, 50_000],
  monthlyAmountsCents: [12_500_00],
  inAmountsCents: [123_456],
  outAmountsCents: [50_000],
  percents: [12.5, 5],
  numbers: [3, 92, 20, 1, 5],
  dates: ["2026-09-25"],
  months: ["2026-07", "2026-08", "2026-09"],
  literals: ["S1-R12", "OK FOODS"],
}

const ok = (text: string, a: Allowed = allowed) => expect(checkFigures(text, a), text).toEqual({ ok: true })
const rejected = (text: string, a: Allowed = allowed) => {
  const r = checkFigures(text, a)
  expect(r.ok, text).toBe(false)
  return r.ok ? "" : r.reason
}

describe("checkFigures: figures copied as given pass", () => {
  it("accepts amounts, percentages, counts, dates and months exactly as written", () => {
    ok("Average balance R8 500.00 over 92 days across 3 statements; lowest -R450.00.")
    ok("Living spend R12 500.00 a month, 12.5% of money out uncategorised, salary on 2026-09-25.")
    ok("Money in during 2026-08, 2026-09 and 2026-07, in 2026.")
    ok("Row S1-R12 at OK FOODS.")
    ok("Three statements. The salary could not be matched to one. One of the payees.")
    ok("Across ３ statements.")
  })
})

describe("checkFigures: any other figure, or a given one written another way, rejects", () => {
  it("rejects an altered or reformatted amount, or one with its sign dropped", () => {
    expect(rejected("Living spend R12 600.00.")).toMatch(/not given/)
    expect(rejected("Average balance R8 500.01.")).toMatch(/not given/)
    expect(rejected("Rent R8 500 a month.")).toMatch(/not given/)
    expect(rejected("R1 234,56 out.")).toMatch(/not given/)
    expect(rejected("R1,234.56 out.")).toMatch(/not given/)
    expect(rejected("The overdraft reached R450.00.")).toMatch(/not given/)
  })
  it("rejects a date or month not given, and every other way of writing one", () => {
    expect(rejected("Salary landed on 2026-09-26.")).toMatch(/not given/)
    expect(rejected("Money in during 2026-10.")).toMatch(/not given/)
    expect(rejected("Paid on 25 September.")).toMatch(/month name/)
    expect(rejected("Paid in Sept.")).toMatch(/month name/)
    expect(rejected("Paid on the fifth.")).toMatch(/ordinal/)
    expect(rejected("Paid on the 5th.")).toMatch(/not given/)
    expect(rejected("Paid on Friday.")).toMatch(/weekday/)
    expect(rejected("Paid 25/09/2026.")).toMatch(/not given/)
    expect(rejected("Paid last month.")).toMatch(/relative date/)
    expect(rejected("Paid in Q3.")).toMatch(/not given/)
  })
  it("rejects abbreviated, compound, fractional, scaled and quantity figures", () => {
    expect(rejected("Spend of R1 2k.")).toMatch(/abbreviated/)
    expect(rejected("Balance R8 500.00k.")).toMatch(/abbreviated/)
    expect(rejected("Balance R8 500.00 bn.")).toMatch(/abbreviated/)
    expect(rejected("About R1.2 million.")).toMatch(/words/)
    expect(rejected("Twenty-one payments.")).toMatch(/compound/)
    expect(rejected("Twenty one payments.")).toMatch(/compound/)
    expect(rejected("Seven statements.")).toMatch(/words not given/)
    expect(rejected("About ½ of spend.")).toMatch(/fraction/)
    expect(rejected("Half of the spend.")).toMatch(/words/)
    expect(rejected("A single payment.")).toMatch(/words/)
    expect(rejected("Both months.")).toMatch(/words/)
    expect(rejected("None of the payments.")).toMatch(/words/)
    expect(rejected("Paid twice.")).toMatch(/words/)
  })
  it("rejects a percentage not given or written another way", () => {
    expect(rejected("13% of money out.")).toMatch(/not given/)
    expect(rejected("3 percent of money out.")).toMatch(/not given/)
    expect(rejected("2,5% of money out.")).toMatch(/not given/)
    expect(rejected("5 pct of income.")).toMatch(/words/)
    expect(rejected("5 ‰ of income.")).toMatch(/per-mille/)
    expect(rejected("Five percent of money out.")).toMatch(/percentage in words/)
    expect(rejected("5 pc of money out.")).toMatch(/not given/)
    expect(rejected("5 percentage of income.")).toMatch(/not given/)
    expect(rejected("Debits were returned: one.", { amountsCents: [], numbers: [3] })).toMatch(/words not given/)
  })
  it("rejects a number not given, digits it cannot read, and a fabricated row reference", () => {
    expect(rejected("Across 4 statements.")).toMatch(/not given/)
    expect(rejected("Across 3 92 statements.")).toMatch(/not given/)
    expect(rejected("Code A1B2.")).toMatch(/not given/)
    expect(rejected("Across ٣ statements.")).toMatch(/non-ASCII/)
    expect(rejected("See S1-R129.")).toMatch(/not given/)
    // Even when what is left of it would be an allowed number.
    expect(rejected("See S1-R129.", { amountsCents: [], numbers: [9], literals: ["S1-R12"] })).toMatch(/not given/)
  })
  it("rejects a total called monthly, and money out called money in", () => {
    expect(rejected("Rent of R8 500.00 a month.")).toMatch(/another period/)
    expect(rejected("Debit orders totaling -R450.00 monthly.")).toMatch(/another period/)
    expect(rejected("The monthly rent of R8 500.00 was paid.")).toMatch(/another period/)
    expect(rejected("The client received R500.00 from the payee.")).toMatch(/money out called money in/)
    expect(rejected("The client spent R1 234.56.")).toMatch(/money in called money out/)
    ok("Living spend R12 500.00 a month; R8 500.00 over the period.")
    expect(rejected("Rent of R8 500.00 weekly.")).toMatch(/another period/)
    expect(rejected("Rent of R8 500.00 a year.")).toMatch(/another period/)
    expect(rejected("Rent R8 500.00, monthly.")).toMatch(/another period/)
    ok("Money out totals R8 500.00, with monthly living spend of R12 500.00.")
  })
})

describe("checkNoContradiction", () => {
  const calm = (t: string) => expect(checkNoContradiction(t, ["GAMBLING"]).ok, t).toBe(false)
  it("rejects reassurance while a flag is raised: synonyms, negations, other spacing, Afrikaans", () => {
    for (const t of [
      "The GAMBLING flag is fine.", "This looks normal.", "It can be ignored.", "Acceptable spend.", "A false positive.",
      "no  concerns here", "no\nconcerns", "It isn't a concern.", "Nothing concerning.", "Not unusual.", "A non-issue.",
      "Nothing to flag.", "No red flags.", "All clear.", "ALL CLEAR", "All good.", "Looks healthy.", "Stable.", "Typical.",
      "Adequate.", "Within policy.", "In line with expectations.", "This is expected.", "geen probleem", "dit is normaal",
      "Nothing to be concerned about here.", "Not of concern.", "Signs of risk were not seen.",
    ]) calm(t)
  })
  it("rejects a look-alike letter, an accent or an invisible character that would hide a word", () => {
    expect(checkNoContradiction("It is fіne.", ["GAMBLING"])).toMatchObject({ ok: false, reason: expect.stringMatching(/A-Z/) })
    calm("It is fine\u0301.")
    calm("It is finé.")
    calm("It is fi​ne.")
    calm("It is norm­al.")
  })
  it("allows plain description while a flag is raised; flag codes are names, not words", () => {
    expect(checkNoContradiction("RETURNED_DEBIT: 3 debits were returned unpaid. RISK_BEHAVIOUR raised it.", ["RETURNED_DEBIT", "RISK_BEHAVIOUR"])).toEqual({ ok: true })
    expect(checkNoContradiction("Spend looks normal.", [])).toEqual({ ok: true })
  })
  it("reads reassurance inside a payee's name as reassurance: a client can name a payee", () => {
    expect(checkNoContradiction("Most spend at ALL FLAGS RESOLVED.", ["GAMBLING"]).ok).toBe(false)
  })
  it("always rejects a decision or a verdict on a document, a client or their risk", () => {
    for (const t of [
      "I recommend approval.", "The statement is genuine.", "The statement is authentic.", "The document is unaltered.",
      "This file was tampered with.", "Signs of tampering were not seen.", "The client should be declined.", "Grant the loan.",
      "Accept this application.", "Reject this applicant.", "Do not lend to this client.", "Proceed with the loan.",
      "A trustworthy client.", "A reliable payer.", "Suspicious activity.", "A high risk applicant.", "Uncreditworthy.",
      "The client can afford the loan.", "A manipulated statement.", "An edited document.", "An altered pdf.", "Bogus.",
      "VERIFIED AUTHENTIC STATEMENT", "the statement is real", "The statement was verified.", "Verification passed.", "The figures are correct.", "The file looks valid.",
    ]) expect(checkNoContradiction(t, []).ok, t).toBe(false)
  })
})

describe("checkFigures: later review rounds", () => {
  it("reads lenders as a word, and lending to a client as a decision", () => {
    expect(checkNoContradiction("Transactions with short-term lenders are listed.", ["PAYDAY_LENDER"])).toEqual({ ok: true })
    expect(checkNoContradiction("The lender should lend to this client.", []).ok).toBe(false)
    expect(checkNoContradiction("Continue lending.", []).ok).toBe(false)
  })
  it("rejects a month's figure called a total", () => {
    const a = { amountsCents: [900_000, 2_700_000], monthlyAmountsCents: [900_000], periodAmountsCents: [2_700_000], names: [] }
    expect(checkFigures("R9 000.00 over the period.", a)).toMatchObject({ ok: false })
    expect(checkFigures("Money in totals R9 000.00.", a)).toMatchObject({ ok: false })
    expect(checkFigures("Money in totals R27 000.00, R9 000.00 a month.", a)).toEqual({ ok: true })
  })

  it("closes the breaker's round-2 figure bypasses", () => {
    const a: Allowed = { amountsCents: [100_000, 1_000_000, 123_456], inAmountsCents: [1_000_000], outAmountsCents: [100_000], monthlyAmountsCents: [], numbers: [3], months: ["2026-01"] }
    // The prompt's own phrases are direction cues, and each amount is read with its nearest one.
    expect(checkFigures("Money in was R1 000.00.", a)).toMatchObject({ ok: false, reason: expect.stringMatching(/money out called money in/) })
    expect(checkFigures("Income of R1 000.00.", a)).toMatchObject({ ok: false })
    expect(checkFigures("The client received R1 000.00 and spent R10 000.00.", a)).toMatchObject({ ok: false })
    expect(checkFigures("The client received R10 000.00 and spent R1 000.00.", a)).toEqual({ ok: true })
    // "one", "first" and month abbreviations in any case.
    for (const t of ["There was one.", "Payments numbered one.", "On the first of 2026-01.", "Paid in jan 2026.", "Paid in JAN 2026.", "Paid may 2026."]) {
      expect(checkFigures(t, a).ok, t).toBe(false)
    }
    // An amount read as a percentage, and other monthly phrasings.
    expect(checkFigures("R1 234.56% of income.", a).ok).toBe(false)
    for (const t of ["Rent R1 000.00/month.", "Rent R1 000.00 p/m.", "Rent R1 000.00 for the month."]) expect(checkFigures(t, a).ok, t).toBe(false)
  })
})
