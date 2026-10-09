import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LoanTable } from "./LoanTable"

// next/link touches requestIdleCallback/`self` on mount, which the node test
// environment does not provide.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function loan(overrides: Partial<Parameters<typeof LoanTable>[0]["loans"][number]> = {}) {
  return {
    id: "l1",
    reference: "LN-AAA",
    principal: 200_000, // R2,000.00 in cents
    outstandingPrincipal: 200_000,
    totalRepayable: 250_000,
    totalPaid: 0,
    status: "ACTIVE",
    startDate: new Date("2026-01-01"),
    maturityDate: new Date("2026-09-26"),
    daysInArrears: 0,
    client: { firstName: "Lesedi", lastName: "Mabtest" },
    product: { name: "Micro Loan" },
    ...overrides,
  }
}

const LOANS = [
  loan(),
  loan({ id: "l2", reference: "LN-BBB", client: { firstName: "Amos", lastName: "Mockery" }, product: { name: "Personal Loan" }, principal: 65_000, outstandingPrincipal: 65_000, daysInArrears: 45 }),
  loan({ id: "l3", reference: "LN-CCC", client: { firstName: "Bonga", lastName: "Jester" }, product: { name: "Personal Loan" }, status: "CLOSED", principal: 150_000, outstandingPrincipal: 0, daysInArrears: 0 }),
]

let renderer: ReactTestRenderer

function references(): string[] {
  return renderer.root
    .findAllByType("tr")
    .flatMap((row) => {
      const cell = row.findAllByType("td")[0]
      const text = cell?.children[0]
      return typeof text === "string" && text.startsWith("LN-") ? [text] : []
    })
}

function setInput(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

describe("LoanTable filters", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<LoanTable loans={LOANS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every loan before filtering", () => {
    expect(references()).toEqual(["LN-AAA", "LN-BBB", "LN-CCC"])
  })

  it("searches on client name", () => {
    setInput("Search loans", "mockery")
    expect(references()).toEqual(["LN-BBB"])
  })

  it("searches on reference", () => {
    setInput("Search loans", "ln-ccc")
    expect(references()).toEqual(["LN-CCC"])
  })

  // Money is stored in cents; staff type the rand figure they can see.
  it("searches on the rand amount, not the cent amount", () => {
    setInput("Search loans", "650")
    expect(references()).toEqual(["LN-BBB"])
    setInput("Search loans", "65000")
    expect(references()).toEqual([])
  })

  it("filters by status", () => {
    setInput("Filter by status", "CLOSED")
    expect(references()).toEqual(["LN-CCC"])
  })

  it("filters by product", () => {
    setInput("Filter by product", "Personal Loan")
    expect(references()).toEqual(["LN-BBB", "LN-CCC"])
  })

  it("filters by arrears bucket", () => {
    setInput("Filter by days in arrears", "HARD")
    expect(references()).toEqual(["LN-BBB"])
    setInput("Filter by days in arrears", "CLEAR")
    expect(references()).toEqual(["LN-AAA", "LN-CCC"])
  })

  it("combines filters", () => {
    setInput("Filter by product", "Personal Loan")
    setInput("Filter by status", "ACTIVE")
    expect(references()).toEqual(["LN-BBB"])
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// loan also returned both larger ones.
// References deliberately carry no digits: a reference containing "50" would
// satisfy the text match and hide whether the amount match is exact.
const SUBSTRING_LOANS = [
  loan({ id: "s1", reference: "LN-AAA", principal: 5_000, outstandingPrincipal: 5_000 }),
  loan({ id: "s2", reference: "LN-BBB", principal: 65_000, outstandingPrincipal: 65_000 }),
  loan({ id: "s3", reference: "LN-CCC", principal: 150_000, outstandingPrincipal: 150_000 }),
  loan({ id: "s4", reference: "LN-DDD", principal: 150_050, outstandingPrincipal: 150_050 }),
]

describe("LoanTable amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<LoanTable loans={SUBSTRING_LOANS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setInput("Search loans", "50")
    expect(references()).toEqual(["LN-AAA"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setInput("Search loans", "1500")
    expect(references()).toEqual(["LN-CCC", "LN-DDD"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setInput("Search loans", "1500.50")
    expect(references()).toEqual(["LN-DDD"])
  })

  it("matches a pasted formatted amount", () => {
    setInput("Search loans", "R 1,500.50")
    expect(references()).toEqual(["LN-DDD"])
  })
})
