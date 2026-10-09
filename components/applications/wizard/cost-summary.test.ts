import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { calculateLoan } from "@/lib/loan-calculator"
import { displayCents } from "./formatters"
import { INVALIDATED_AFFORDABILITY } from "./types"
import { validateStep3Affordability } from "@/lib/validation/application-wizard"
import type { ApplicationWizardData } from "./types"

// The wizard's affordability summary (Step 3) and review block (Step 4) show
// the consumer's cost of credit, and the NCA §92 quotation checkbox sits
// directly beneath it. Two things have to hold:
//   1. the arithmetic foots, and
//   2. the screen actually RENDERS every line the arithmetic depends on.
//
// (2) is the part that is easy to fake. The assertions in THIS file read
// component source, which is a cheap first line and nothing more: it cannot see
// a row that is commented out or sitting behind a dead conditional, both of
// which were shown to leave a source-only suite green while the disclosure line
// vanished from the screen.
//
// The real guard is cost-summary-render.test.tsx, which renders both screens
// via react-dom/server and asserts each value against its own label.

const MICRO_LOAN = {
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 100000,
  monthlyServiceFee: 6900,
  productType: "MICRO" as const,
}

// Source with JSX block comments stripped. A row that has been commented out
// does NOT render, so asserting against raw source would let `{/* <Row … /> */}`
// pass — which is exactly how a disclosure line goes missing during a debug
// session and never comes back.
const read = (f: string) =>
  readFileSync(join(process.cwd(), "components/applications/wizard", f), "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")

// Exactly the fields Step3Affordability patches into wizard state. If a charge
// is not in here, it is not on screen.
function displayedCostLines(principal: number, termDays: number, mode?: "DEFERRED" | "UPFRONT") {
  const r = calculateLoan({ principal, termDays, ...MICRO_LOAN, ...(mode && { initiationFeePayment: mode }) })
  return {
    totalInterest: r.totalInterest,
    initiationFee: r.initiationFee,
    serviceFees: r.serviceFees,
    totalRepayable: r.totalRepayable,
  }
}

describe("the cost lines are actually rendered", () => {
  // Guards the regression directly: drop a row and these fail.
  it.each(["Amount", "Total interest", "Initiation fee", "Service fees", "Total repayable"])(
    "Step 3 renders the %s tile",
    (label) => {
      // Whitespace-tolerant: Prettier reflows a label onto its own line as the
      // markup grows, and that must not read as a deleted disclosure line.
      expect(read("Step3Affordability.tsx")).toMatch(new RegExp(`>\\s*${label}\\s*</p>`))
    },
  )

  it.each(["Total interest", "Initiation fee", "Service fees", "Total repayable"])(
    "Step 4 renders the %s row",
    (label) => {
      expect(read("Step4Review.tsx")).toContain(`label="${label}"`)
    },
  )

  it("binds each Step 4 row to its own wizard field, not a duplicate", () => {
    const s4 = read("Step4Review.tsx")
    for (const f of ["totalInterest", "initiationFee", "serviceFees", "totalRepayable"]) {
      expect(s4).toContain(`displayCents(data.${f})`)
    }
  })
})

describe("wizard cost summary foots to total repayable", () => {
  // Spread of sizes/terms so the assertion can't be satisfied by one lucky case:
  // R900 stays under the fee cap, R20,000 is pinned by initiationFeeMax, and the
  // 90-day term accrues multiple monthly service fees.
  const CASES: Array<[number, number]> = [
    [200000, 30],   // the R2,000 / 30-day demo that surfaced this
    [300000, 30],   // R3,000
    [90000, 30],    // R900 — small, fee well under the cap
    [2000000, 90],  // R20,000 / 90 days — fee capped, 3 service fees
  ]

  it.each(CASES)("principal %i cents over %i days: lines sum to the total", (principal, termDays) => {
    const l = displayedCostLines(principal, termDays)
    expect(principal + l.totalInterest + l.initiationFee + l.serviceFees).toBe(l.totalRepayable)
  })

  it("would NOT foot on interest alone — the fee lines are load-bearing", () => {
    const l = displayedCostLines(200000, 30)
    expect(200000 + l.totalInterest).not.toBe(l.totalRepayable)
    expect(l.totalRepayable - 200000 - l.totalInterest).toBe(l.initiationFee + l.serviceFees)
  })

  it("shows the exact R2,000 demo figures", () => {
    // displayCents emits non-breaking spaces (display channel — see the
    // formatZAR plain-space/nbsp split). Normalise so this asserts on the
    // NUMBERS, not on an invisible character.
    //   written as an escape, not pasted: a literal nbsp is invisible in a
    // diff and does not survive a file rewrite intact.
    const shown = (cents: number) => displayCents(String(cents)).replace(/\u00A0/g, " ")
    const l = displayedCostLines(200000, 30)
    expect(shown(l.totalInterest)).toBe("R 100,00")
    expect(shown(l.initiationFee)).toBe("R 300,00")
    expect(shown(l.serviceFees)).toBe("R 69,00")
    expect(shown(l.totalRepayable)).toBe("R 2 469,00")
  })

  it("caps the initiation fee at the product ceiling", () => {
    // R20,000 x 15% = R3,000, capped to R1,000. A summary that showed the
    // uncapped fee would overstate the cost of credit.
    const l = displayedCostLines(2000000, 90)
    expect(l.initiationFee).toBe(MICRO_LOAN.initiationFeeMax)
  })

  it("the displayed identity holds ONLY for DEFERRED — UPFRONT would overstate", () => {
    // calculateLoan returns the full initiationFee in both modes, but excludes
    // it from totalRepayable under UPFRONT (it comes off the advance instead).
    // The wizard never passes an election, so it renders the DEFERRED figures
    // and LoanApplication.initiationFeePayment defaults DEFERRED — consistent
    // today. This pins that coupling: if anyone threads the election into the
    // wizard, the four displayed lines stop footing and this test says so.
    const d = displayedCostLines(200000, 30, "DEFERRED")
    const u = displayedCostLines(200000, 30, "UPFRONT")
    expect(200000 + d.totalInterest + d.initiationFee + d.serviceFees).toBe(d.totalRepayable)
    expect(200000 + u.totalInterest + u.initiationFee + u.serviceFees).not.toBe(u.totalRepayable)
    expect(u.totalRepayable).toBe(d.totalRepayable - u.initiationFee)
    // The wizard's own call site must stay election-free for the above to hold.
    // Match the PROPERTY form (`initiationFeePayment:`), not the bare word — the
    // word appears in prose explaining this very invariant, and a test that
    // cannot tell code from a comment gets deleted the first time it false-reds.
    expect(read("Step3Affordability.tsx")).not.toMatch(/initiationFeePayment\s*:/)
  })
})

describe("a stale cost of credit cannot reach the §92 certification screen", () => {
  // "Edit" on the review screen jumps 4 -> 2 -> 4 without mounting Step 3, so a
  // changed amount would otherwise leave the previous loan's figures on display
  // above the quotation checkbox.
  it("blanks every computed money field when a calc input changes", () => {
    for (const f of ["monthlyInstalment", "totalInterest", "initiationFee", "serviceFees", "totalRepayable"]) {
      expect(INVALIDATED_AFFORDABILITY[f as keyof typeof INVALIDATED_AFFORDABILITY]).toBe("")
    }
  })

  it("blocks submission until the affordability check is re-run", () => {
    const errs = validateStep3Affordability({ ...INVALIDATED_AFFORDABILITY } as ApplicationWizardData)
    expect(errs.affordabilityFlag).toBeTruthy()
  })

  it("clears a prior reckless-lending acknowledgement", () => {
    // A FAIL the user acknowledged must not carry over to a different loan.
    expect(INVALIDATED_AFFORDABILITY.recklessLendingConfirmed).toBe(false)
  })

  // Every input the Step 3 effect depends on, and the file that owns it. The
  // previous version of this test read Step2LoanParams only — which is why it
  // could not see that switching CLIENT from the review screen carried a stale
  // §81 flag onto a client with a completely different NDI.
  it.each([
    ["Step1ClientSelect.tsx", "clientId"],
    ["Step2LoanParams.tsx", "productId"],
    ["Step2LoanParams.tsx", "appliedAmount"],
    ["Step2LoanParams.tsx", "appliedTermDays"],
  ])("%s invalidates the snapshot when %s changes", (file, field) => {
    // Anchor on the patch call itself, not the first mention of the field:
    // `data.appliedAmount` / `errors.appliedAmount` also appear in these files,
    // and a positional slice would drift the moment one gains a colon.
    const src = read(file)
    const call = new RegExp(`patch\\(\\{[^}]*\\b${field}\\s*:[\\s\\S]{0,200}?\\}\\)`)
    const m = src.match(call)
    expect(m, `no patch({ ${field}: … }) found in ${file}`).toBeTruthy()
    expect(m![0]).toContain("INVALIDATED_AFFORDABILITY")
  })
})
