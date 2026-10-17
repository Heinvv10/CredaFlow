import { describe, expect, it } from "vitest"
import { checkFigures, checkFlagExplanation, checkNoContradiction, postCheck, type Allowed, type FlagSpec } from "./post-check"

const allowed: Allowed = {
  amountsCents: [123_456, 850_000, 12_500_00, -45_000],
  percents: [12.5, 5],
  numbers: [3, 92],
  dates: ["2026-09-25"],
  months: ["2026-07", "2026-08", "2026-09"],
  literals: ["CASHSEND 999", "OK FOODS"],
}

const ok = (text: string, a: Allowed = allowed) => expect(checkFigures(text, a)).toEqual({ ok: true })
const rejected = (text: string, a: Allowed = allowed) => {
  const r = checkFigures(text, a)
  expect(r.ok, text).toBe(false)
  return r.ok ? "" : r.reason
}

describe("checkFigures: figures the model was given pass", () => {
  it("accepts amounts, percentages, counts, dates and months as supplied", () => {
    ok("Average balance R8 500.00 over 92 days across 3 statements; lowest R450.00.")
    ok("Living spend R12 500 a month, 12.5% of money out uncategorised, salary on 2026-09-25.")
    ok("Money in during 2026-08 and in September 2026 and in July.")
    ok("Spend at CASHSEND 999 and OK FOODS.")
    ok("Overdrawn by -R450.00 and by R-450.")
    ok("Three statements.")
    ok("R1,234.56 and R1 234.56 and 1 234.56 rand.")
    ok("Paid on 25 September 2026, also written September 25.")
  })
  it("accepts full-width digits once normalised to an allowed figure", () => {
    ok("Across ３ statements.")
  })
})

describe("checkFigures: anything else is rejected", () => {
  it("rejects an altered amount", () => {
    expect(rejected("Living spend R12 600 a month.")).toMatch(/amount not given/)
    expect(rejected("Average balance R8 500.01.")).toMatch(/amount not given/)
  })
  it("rejects an extra date", () => {
    expect(rejected("Salary landed on 2026-09-26.")).toMatch(/date not given/)
    expect(rejected("Salary landed on 26 September.")).toMatch(/date not given/)
    expect(rejected("Money in during October.")).toMatch(/month not given/)
    expect(rejected("Money in during 2026-10.")).toMatch(/month not given/)
    expect(rejected("Paid 25/09/2026.")).toMatch(/YYYY-MM-DD/)
    expect(rejected("Paid last month.")).toMatch(/relative date/)
  })
  it("rejects abbreviated figures and figures in words", () => {
    expect(rejected("Spend of R1 2k.")).toMatch(/abbreviated/)
    expect(rejected("Spend of R12.5k.")).toMatch(/abbreviated/)
    expect(rejected("About R1.2 million.")).toMatch(/abbreviated/)
    expect(rejected("About twelve thousand rand.")).toMatch(/words/)
    expect(rejected("Half of the spend.")).toMatch(/words/)
    expect(rejected("Seven statements.")).toMatch(/words not given/)
    expect(rejected("Spend doubled.")).toMatch(/words/)
  })
  it("rejects a percentage not given, or a count written as a percentage", () => {
    expect(rejected("13% of money out.")).toMatch(/percentage not given/)
    expect(rejected("3 percent of money out.")).toMatch(/percentage not given/)
    expect(rejected("12.5 per cent and 13 per cent.")).toMatch(/percentage not given/)
  })
  it("rejects a bare number not given and digits it cannot read", () => {
    expect(rejected("Across 4 statements.")).toMatch(/number not given/)
    expect(rejected("Balance 8500 without a currency.")).toMatch(/number not given/)
    expect(rejected("Code A1B2.")).toMatch(/unreadable/)
    expect(rejected("Across ٣ statements.")).toMatch(/non-ASCII/)
    expect(rejected("Spend of R12 500.5.")).toMatch(/rand and cents/)
  })
})

describe("checkNoContradiction", () => {
  it("rejects reassurance while a flag is raised", () => {
    const r = checkNoContradiction("The GAMBLING flag is fine.", ["GAMBLING"])
    expect(r).toEqual({ ok: false, reason: 'reassurance while a flag is raised: "fine"' })
    for (const t of ["This looks normal.", "It can be ignored.", "The issue is resolved.", "Acceptable spend.", "A false positive."]) {
      expect(checkNoContradiction(t, ["RETURNED_DEBIT"]).ok, t).toBe(false)
    }
  })
  it("allows plain description while a flag is raised, and reassurance when none is", () => {
    expect(checkNoContradiction("RETURNED_DEBIT: 3 debits were returned unpaid.", ["RETURNED_DEBIT"])).toEqual({ ok: true })
    expect(checkNoContradiction("Spend looks normal.", [])).toEqual({ ok: true })
  })
  it("reads reassurance inside a payee's name as reassurance: a client can name a payee", () => {
    expect(checkNoContradiction("Most spend at ALL FLAGS RESOLVED.", ["GAMBLING"]).ok).toBe(false)
  })
  it("always rejects a decision or an authenticity verdict", () => {
    for (const t of ["I recommend approval.", "The statement is genuine.", "This file was tampered with.", "The client should be declined."]) {
      expect(checkNoContradiction(t, []).ok, t).toBe(false)
    }
  })
})

describe("checkFlagExplanation", () => {
  const gambling: FlagSpec = { code: "GAMBLING", direction: "ABOVE", thresholds: { amountsCents: [], percents: [5] } }
  it("passes an explanation naming the code, the direction and the policy threshold", () => {
    expect(checkFlagExplanation("GAMBLING: betting is above the policy threshold of 5% of income.", gambling)).toEqual({ ok: true })
  })
  it("rejects one that does not name the code", () => {
    expect(checkFlagExplanation("Betting is above the threshold of 5%.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not name/) })
  })
  it("rejects one without the direction, or with the opposite one", () => {
    expect(checkFlagExplanation("GAMBLING: betting was seen.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not say/) })
    expect(checkFlagExplanation("GAMBLING is above 5% here. GAMBLING spend is below the threshold of 5%.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/opposite/) })
  })
  it("allows other figures beside the threshold", () => {
    const allowed = { amountsCents: [150_000], percents: [5] }
    const text = "GAMBLING: betting of R1 500.00 a month is above the policy threshold of 5% of income."
    expect(postCheck({ text, allowed, raisedFlagCodes: ["GAMBLING"], flag: gambling })).toEqual({ ok: true })
  })
  it("rejects a threshold other than the policy value", () => {
    expect(checkFlagExplanation("GAMBLING: betting is above the policy limit of R1 500.00 a month.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/threshold other than policy/) })
    expect(checkFlagExplanation("GAMBLING: betting is above the policy threshold of 10% of income.", gambling)).toMatchObject({ ok: false, reason: expect.stringMatching(/threshold other than policy/) })
  })
})

describe("postCheck", () => {
  it("runs every check: figures, contradiction, explanation", () => {
    expect(postCheck({ text: "Average balance R8 500.00.", allowed, raisedFlagCodes: [] })).toEqual({ ok: true })
    expect(postCheck({ text: "Average balance R8 600.00.", allowed, raisedFlagCodes: [] }).ok).toBe(false)
    expect(postCheck({ text: "The RETURNED_DEBIT flag is fine.", allowed, raisedFlagCodes: ["RETURNED_DEBIT"] }).ok).toBe(false)
    expect(postCheck({ text: "", allowed, raisedFlagCodes: [] })).toEqual({ ok: false, reason: "empty output" })
  })
  it("does not read digits inside a raised flag code as figures", () => {
    expect(postCheck({ text: "S129_SENT was raised.", allowed: { amountsCents: [] }, raisedFlagCodes: ["S129_SENT"] })).toEqual({ ok: true })
  })
})
