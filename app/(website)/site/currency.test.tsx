import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { JurisdictionProvider } from "@/components/JurisdictionProvider"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import type { Currency, Jurisdiction } from "@/lib/jurisdiction/profiles"
import { formatZAR } from "@/lib/loan-calculator"
import { publicLoanProducts } from "@/lib/public-loan-products"
import { activeCurrencySymbol } from "@/lib/utils"
import { siteJurisdictionFor } from "@/lib/website/site-jurisdiction"

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: async () => ACME_LENDER }))
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))

import CalculatorsPage from "./calculators/page"
import QualifyResult from "./qualify/QualifyResult"
import QualifyStepTwo from "./qualify/QualifyStepTwo"
import QualifyStepOne from "./qualify/QualifyStepOne"
import AffordabilityTab from "./calculators/AffordabilityTab"
import ComparisonTab from "./calculators/ComparisonTab"

afterEach(() => resetActiveJurisdiction())

const NBSP = " "
const CASES: ReadonlyArray<[Jurisdiction, Currency, string]> = [
  ["KE", "KES", "KSh"],
  ["LS", "LSL", "M"],
  ["LS", "ZAR", "R"],
]

describe("the display money format", () => {
  it("is the lender's symbol, a no-break space and the amount; a South African lender's is unchanged", () => {
    expect(formatZAR(123456)).toBe(`R${NBSP}1,234.56`)
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(formatZAR(123456)).toBe(`KSh${NBSP}1,234.56`)
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(formatZAR(100000000)).toBe(`M${NBSP}1,000,000.00`)
  })
})

describe.each(CASES)("the qualify and calculator pages of a %s lender billed in %s", (code, currency, symbol) => {
  const site = siteJurisdictionFor(code)
  const inSite = (el: React.ReactNode) => renderToStaticMarkup(<WebsiteIdentityProvider identity={ACME_LENDER} jurisdiction={site}>{el}</WebsiteIdentityProvider>)

  it("step two prints the slider amounts and tier ranges in the lender's currency", () => {
    setActiveJurisdiction({ jurisdiction: code, currency })
    const html = inSite(<QualifyStepTwo data={{ amount: 5000, purpose: "", term: 7 }} onChange={() => {}} onNext={() => {}} onBack={() => {}} products={publicLoanProducts} />)
    expect(html).toContain(`${symbol} 5,000`)
    expect(html).toMatch(new RegExp(`Up to ${symbol} [\\d,]+`))
    expect(html).toMatch(new RegExp(`Over ${symbol} [\\d,]+`))
    if (symbol !== "R") expect(html).not.toMatch(/\bR [\d,]/)
    expect(html).not.toMatch(/\d \d{3}/)
  })

  it("the result and every calculator tab use it", async () => {
    setActiveJurisdiction({ jurisdiction: code, currency })
    const result = inSite(<QualifyResult incomeCents={2_000_000} expensesCents={500_000} amountRands={3000} termValue={3} products={publicLoanProducts} onRestart={() => {}} />)
    const calculators = inSite(await CalculatorsPage() as React.ReactElement)
    for (const html of [result, calculators]) {
      expect(html).toContain(`${symbol}${NBSP}`)
      if (symbol !== "R") expect(html).not.toContain(`R${NBSP}`)
    }
  })
})

describe.each(CASES)("the amount inputs of a %s lender billed in %s", (code, currency, symbol) => {
  it("prefix the lender's symbol and widen the padding for a long one", () => {
    setActiveJurisdiction({ jurisdiction: code, currency })
    const site = siteJurisdictionFor(code)
    const step = { employmentStatus: "", monthlyIncome: "", monthlyExpenses: "" }
    const html = [
      <QualifyStepOne key="q" data={step} onChange={() => {}} onNext={() => {}} />,
      <AffordabilityTab key="a" />,
      <ComparisonTab key="c" />,
    ].map((el) => renderToStaticMarkup(<WebsiteIdentityProvider identity={ACME_LENDER} jurisdiction={site}>{el}</WebsiteIdentityProvider>))
    for (const h of html) {
      expect(h).toContain(`>${symbol}</span>`)
      if (symbol !== "R") expect(h).not.toContain(">R</span>")
    }
    for (const h of html) expect(h).toContain(symbol.length > 1 ? "pl-12" : "pl-8")
  })
})

// A client component reads the browser's copy of the jurisdiction. The root layout's provider sets it while
// rendering, before any child, so server HTML and hydration print the same symbol (components/JurisdictionProvider.tsx).
describe("a client component's currency symbol", () => {
  const Probe = () => <span>{activeCurrencySymbol()}</span>

  it("is the lender's, from the provider, on a page that starts with nothing loaded", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>R</span>")
    expect(renderToStaticMarkup(<JurisdictionProvider jurisdiction="KE" currency="KES"><Probe /></JurisdictionProvider>)).toBe("<span>KSh</span>")
  })
})
