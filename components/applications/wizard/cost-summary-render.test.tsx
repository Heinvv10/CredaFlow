import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Step3Affordability } from "./Step3Affordability"
import { Step4Review } from "./Step4Review"
import { EMPTY_APPLICATION_WIZARD_DATA, INVALIDATED_AFFORDABILITY } from "./types"
import type { ApplicationWizardData } from "./types"

// A REAL render of the two screens that carry the cost of credit, using
// react-dom/server (already a dependency — no jsdom needed, and effects don't
// run, which is fine because these assertions are about what the markup shows
// for a given wizard state).
//
// This exists because source-reading assertions cannot see the difference
// between a row that renders and one that is commented out or sits behind a
// dead conditional. Both were demonstrated to slip past a source-only guard:
// `{/* <Row …/> */}` and `{false && <p>Service fees</p>}` each left the suite
// green while the disclosure line vanished from the screen. On an NCA §92
// surface that gap matters, so the guard renders the component instead.

const DATA: ApplicationWizardData = {
  ...EMPTY_APPLICATION_WIZARD_DATA,
  clientId: "c1",
  productId: "p1",
  appliedAmount: "2000",
  appliedTermDays: "30",
  purpose: "demo",
  // Distinct values so a row wired to the wrong field is visible, not masked by
  // two lines happening to hold the same number.
  monthlyInstalment: "246900",
  totalInterest: "10000",
  initiationFee: "30000",
  serviceFees: "6900",
  totalRepayable: "246900",
  affordabilityFlag: "PASS",
}

const PRODUCT = {
  id: "p1",
  name: "Micro Loan",
  minAmount: 50000,
  maxAmount: 500000,
  minTermDays: 30,
  maxTermDays: 30,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 100000,
  monthlyServiceFee: 6900,
}

const noop = () => {}

function renderStep3(data: ApplicationWizardData = DATA) {
  return renderToStaticMarkup(
    <Step3Affordability
      data={data}
      patch={noop}
      errors={{}}
      mode="staff"
      products={[PRODUCT] as never}
      selectedClient={null}
    />,
  )
}

function renderStep4(
  data: ApplicationWizardData = DATA,
  autoBundleEnabled = true,
) {
  return renderToStaticMarkup(
    <Step4Review
      data={data}
      patch={noop}
      errors={{}}
      mode="staff"
      editJump={noop}
      clients={[{ id: "c1", firstName: "Thandi", lastName: "Mocktest", email: "t@x.co" }] as never}
      products={[PRODUCT] as never}
      creditLifeOffer={{
        productId: "credit-life-1",
        productName: "Credit Life",
        insurerId: "insurer-1",
        insurerName: "Test Insurer",
        autoBundleEnabled,
      }}
    />,
  )
}

// Non-breaking space written as an ESCAPE, not pasted: a literal U+00A0 is
// invisible in a diff and does not survive a file rewrite intact.
const flat = (html: string) => html.replace(/\u00A0/g, " ")

// Reads the value rendered ADJACENT to its label. Asserting the label and the
// value independently (two separate toContains) is not enough: transposing the
// initiation-fee and service-fee bindings renders "Initiation fee R 69,00" and
// "Service fees R 300,00" — a materially wrong §92 disclosure — while every
// string still appears somewhere on the page. Verified: that swap passed 41/41
// before this helper existed.
function valueFor(html: string, label: string): string {
  // Step 3 tiles: <p ...>Label</p><p ...>Value</p>
  // Step 4 rows:  <dt ...>Label</dt><dd ...>Value</dd>
  const m = html.match(new RegExp(`>${label}</(?:p|dt)><(?:p|dd)[^>]*>([^<]*)<`))
  if (!m) throw new Error(`no value rendered next to "${label}"`)
  return m[1].trim()
}

describe("Step 3 renders the full cost of credit", () => {
  it.each([
    ["Amount", "R 2 000,00"],
    ["Total interest", "R 100,00"],
    ["Initiation fee", "R 300,00"],
    ["Service fees", "R 69,00"],
    ["Total repayable", "R 2 469,00"],
  ])("shows %s = %s on the SAME row", (label, value) => {
    expect(valueFor(flat(renderStep3()), label)).toBe(value)
  })

  it("the four breakdown lines it displays sum to the total it displays", () => {
    // Reads the rendered figures back out of the markup, so this asserts on what
    // a human actually sees rather than on the calculator's return value.
    const html = flat(renderStep3())
    const cents = (label: string) => {
      const m = valueFor(html, label).match(/^R ([\d ]+),(\d{2})$/)
      if (!m) throw new Error(`unparseable rendered value for ${label}`)
      return Number(m[1].replace(/ /g, "")) * 100 + Number(m[2])
    }
    expect(
      cents("Amount") + cents("Total interest") + cents("Initiation fee") + cents("Service fees"),
    ).toBe(cents("Total repayable"))
  })

  it("blanks EVERY money line when the snapshot has been invalidated", () => {
    // Uses the real constant, not a hand-picked subset — that is the whole
    // point: after an edit, no stale figure may survive anywhere on the screen.
    const html = flat(renderStep3({ ...DATA, ...INVALIDATED_AFFORDABILITY }))
    for (const stale of ["R 2 469,00", "R 100,00", "R 300,00", "R 69,00"]) {
      expect(html, `stale figure ${stale} still rendered`).not.toContain(stale)
    }
    // The Amount tile is NOT part of the snapshot — it reflects the edit itself
    // and must keep showing the new value.
    expect(html).toContain("R 2 000,00")
  })
})

describe("Step 4 renders the full cost of credit above the PASQ delivery notice", () => {
  it.each([
    ["Total interest", "R 100,00"],
    ["Initiation fee", "R 300,00"],
    ["Service fees", "R 69,00"],
    ["Total repayable", "R 2 469,00"],
  ])("shows %s = %s on the SAME row", (label, value) => {
    expect(valueFor(flat(renderStep4()), label)).toBe(value)
  })

  it("puts the cost figures BEFORE the PASQ delivery notice", () => {
    // Order matters: the notice must sit under the indicative disclosure, not above it.
    const html = flat(renderStep4())
    expect(html.indexOf("Initiation fee")).toBeGreaterThan(-1)
    expect(html.indexOf("Initiation fee")).toBeLessThan(html.indexOf("versioned Pre-Agreement Statement"))
    expect(html.indexOf("Service fees")).toBeLessThan(html.indexOf("versioned Pre-Agreement Statement"))
  })

  it("shows the exact credit-life product, insurer, and premium before the PASQ delivery notice", () => {
    const html = flat(renderStep4())

    expect(html).toContain("Credit Life · Test Insurer · exact monthly premium")
    expect(html).toContain("R 9.00")
    expect(html.indexOf("Credit Life · Test Insurer")).toBeLessThan(html.indexOf("versioned Pre-Agreement Statement"))
    expect(html.indexOf("R 9.00")).toBeLessThan(html.indexOf("versioned Pre-Agreement Statement"))
  })

  it("does not present ACCEPTED while auto-bundling is contained", () => {
    const html = flat(renderStep4(DATA, false))

    expect(html).toContain("Credit-life cover is not available for this application")
    expect(html).toContain("will proceed without credit-life cover")
    expect(html).not.toContain("exact monthly premium")
    // No election exists, so no radio at all — not a disabled "add cover" one (Fair Score audit).
    expect(html).not.toContain('type="radio"')
  })
})
