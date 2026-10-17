import { describe, expect, it } from "vitest"
import { checkFigures, checkFlagExplanation, checkNoContradiction, postCheck, type Allowed, type FlagSpec } from "./post-check"

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
    expect(rejected("Spend of R1 2k.")).toMatch(/not given/)
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
  })
  it("rejects a number not given, digits it cannot read, and a fabricated row reference", () => {
    expect(rejected("Across 4 statements.")).toMatch(/not given/)
    expect(rejected("Code A1B2.")).toMatch(/not given/)
    expect(rejected("Across ٣ statements.")).toMatch(/non-ASCII/)
    expect(rejected("See S1-R129.")).toMatch(/not given/)
    // Even when what is left of it would be an allowed number.
    expect(rejected("See S1-R129.", { amountsCents: [], numbers: [9], literals: ["S1-R12"] })).toMatch(/not given/)
  })
  it("rejects a total called monthly, and money out called money in", () => {
    expect(rejected("Rent of R8 500.00 a month.")).toMatch(/called monthly/)
    expect(rejected("Debit orders totaling -R450.00 monthly.")).toMatch(/called monthly/)
    expect(rejected("The client received R500.00 from the payee.")).toMatch(/money out called money in/)
    expect(rejected("The client spent R1 234.56.")).toMatch(/money in called money out/)
    ok("Living spend R12 500.00 a month; R8 500.00 over the period.")
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
  it("rejects a look-alike letter or an invisible character that would hide a word", () => {
    expect(checkNoContradiction("It is fіne.", ["GAMBLING"])).toMatchObject({ ok: false, reason: expect.stringMatching(/Latin/) })
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
      "VERIFIED AUTHENTIC STATEMENT", "the statement is real",
    ]) expect(checkNoContradiction(t, []).ok, t).toBe(false)
  })
})

describe("checkFlagExplanation", () => {
  const gambling: FlagSpec = { code: "GAMBLING", direction: "ABOVE", thresholds: { amountsCents: [], percents: [5] } }
  it("passes an explanation naming the code, the direction and the policy threshold", () => {
    expect(checkFlagExplanation("GAMBLING: betting is above the policy threshold of 5% of income.", gambling)).toEqual({ ok: true })
  })
  it("allows other figures beside the threshold", () => {
    const a = { amountsCents: [150_000], monthlyAmountsCents: [150_000], percents: [5] }
    expect(postCheck({ text: "GAMBLING: betting of R1 500.00 a month is above the policy threshold of 5% of income.", allowed: a, raisedFlagCodes: ["GAMBLING"], flag: gambling })).toEqual({ ok: true })
  })
  it("rejects one that does not name the code", () => {
    expect(checkFlagExplanation("Betting is above the threshold of 5%.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not name/) })
  })
  it("rejects one without the direction, with it negated, or with the opposite one anywhere", () => {
    expect(checkFlagExplanation("GAMBLING: betting was seen. It was checked after the rule ran.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not say/) })
    expect(checkFlagExplanation("GAMBLING is not above the policy threshold of 5%.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/negates/) })
    expect(checkFlagExplanation("GAMBLING was raised. Spend is above 5%. Spend is below the threshold of 5%.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/opposite/) })
  })
  it("rejects a threshold other than the policy value, before or after the word, or any other percentage", () => {
    expect(checkFlagExplanation("GAMBLING: betting is above the policy limit of R1 500.00 a month.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/threshold other than policy/) })
    expect(checkFlagExplanation("GAMBLING: betting is above the 10% policy limit.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/threshold other than policy/) })
    expect(checkFlagExplanation("GAMBLING is raised when betting is above 12.5% of income.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/threshold other than policy/) })
  })
})

describe("postCheck", () => {
  it("runs every check: figures, language, explanation", () => {
    expect(postCheck({ text: "Average balance R8 500.00.", allowed, raisedFlagCodes: [] })).toEqual({ ok: true })
    expect(postCheck({ text: "Average balance R8 600.00.", allowed, raisedFlagCodes: [] }).ok).toBe(false)
    expect(postCheck({ text: "The RETURNED_DEBIT flag is fine.", allowed, raisedFlagCodes: ["RETURNED_DEBIT"] }).ok).toBe(false)
    expect(postCheck({ text: "", allowed, raisedFlagCodes: [] })).toEqual({ ok: false, reason: "empty output" })
  })
  it("does not read digits inside a raised flag code as figures", () => {
    expect(postCheck({ text: "S129_SENT was raised.", allowed: { amountsCents: [] }, raisedFlagCodes: ["S129_SENT"] })).toEqual({ ok: true })
  })
})
