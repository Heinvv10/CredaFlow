import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DisbursementsClient } from "./DisbursementsClient"

// next/link touches requestIdleCallback/`self` on mount, which the node test
// environment does not provide.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function application(overrides: Partial<Parameters<typeof DisbursementsClient>[0]["applications"][number]> = {}) {
  return {
    id: "a1",
    appliedAmount: 200_000, // R2,000.00 in cents
    repaymentMethod: "EFT",
    client: { firstName: "Lesedi", lastName: "Mabtest" },
    product: { name: "Micro Loan" },
    ...overrides,
  }
}

const APPLICATIONS = [
  application(),
  application({ id: "a2", client: { firstName: "Amos", lastName: "Mockery" }, product: { name: "Personal Loan" }, appliedAmount: 65_000, repaymentMethod: "DEBIT_ORDER" }),
  application({ id: "a3", client: { firstName: "Bonga", lastName: "Jester" }, product: { name: "Personal Loan" }, appliedAmount: 150_000, repaymentMethod: "EFT" }),
]

let renderer: ReactTestRenderer

function names(): string[] {
  return renderer.root
    .findAllByType("a")
    .filter((el) => typeof el.props.href === "string" && el.props.href.startsWith("/applications/") && el.props.children !== "Disburse")
    .map((el) => el.children.join(""))
}

function setInput(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

describe("DisbursementsClient filters", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<DisbursementsClient applications={APPLICATIONS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every application before filtering", () => {
    expect(names()).toEqual(["Lesedi Mabtest", "Amos Mockery", "Bonga Jester"])
  })

  it("searches on client name", () => {
    setInput("Search ready to disburse", "mockery")
    expect(names()).toEqual(["Amos Mockery"])
  })

  // Money is stored in cents; staff type the rand figure they can see.
  it("searches on the rand amount, not the cent amount", () => {
    setInput("Search ready to disburse", "650")
    expect(names()).toEqual(["Amos Mockery"])
    setInput("Search ready to disburse", "65000")
    expect(names()).toEqual([])
  })

  it("filters by product", () => {
    setInput("Filter by product", "Personal Loan")
    expect(names()).toEqual(["Amos Mockery", "Bonga Jester"])
  })

  it("filters by repayment method", () => {
    setInput("Filter by repayment method", "DEBIT_ORDER")
    expect(names()).toEqual(["Amos Mockery"])
  })

  it("combines filters", () => {
    setInput("Filter by product", "Personal Loan")
    setInput("Filter by repayment method", "EFT")
    expect(names()).toEqual(["Bonga Jester"])
  })

  it("shows a distinct empty state when filters match nothing", () => {
    setInput("Search ready to disburse", "nonexistent client")
    expect(names()).toEqual([])
    const empty = renderer.root.findAllByType("div").find((el) =>
      typeof el.children[0] === "string" && el.children[0].includes("No applications match these filters")
    )
    expect(empty).toBeDefined()
  })
})

// Prisma types repaymentMethod nullable, and a null must never be silently
// folded into a real method (the pre-existing ternary read a null as
// "Debit order").
describe("DisbursementsClient null repayment method", () => {
  const NULL_METHOD_APPLICATIONS = [
    application(),
    application({ id: "a4", client: { firstName: "Nomsa", lastName: "Zulu" }, repaymentMethod: null }),
  ]

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<DisbursementsClient applications={NULL_METHOD_APPLICATIONS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("renders 'Method not set' for a null repayment method", () => {
    const text = renderer.root.findAllByType("p").find((el) => el.children.join("").includes("Method not set"))
    expect(text).toBeDefined()
  })

  it("offers 'Method not set' as its own filter option and can filter by it", () => {
    const select = renderer.root.findByProps({ "aria-label": "Filter by repayment method" })
    const optionLabels = select.findAllByType("option").map((o) => o.props.children)
    expect(optionLabels).toContain("Method not set")

    act(() => {
      select.props.onChange({ target: { value: "NONE" } })
    })
    expect(names()).toEqual(["Nomsa Zulu"])
  })

  it("is not matched by a search for 'debit'", () => {
    setInput("Search ready to disburse", "debit")
    expect(names()).toEqual([])
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// application also returned both larger ones.
const SUBSTRING_APPLICATIONS = [
  application({ id: "s1", client: { firstName: "Fifty", lastName: "Rand" }, appliedAmount: 5_000 }),
  application({ id: "s2", client: { firstName: "Six", lastName: "Fifty" }, appliedAmount: 65_000 }),
  application({ id: "s3", client: { firstName: "Fifteen", lastName: "Hundred" }, appliedAmount: 150_000 }),
  application({ id: "s4", client: { firstName: "Fifteen", lastName: "Fifty" }, appliedAmount: 150_050 }),
]

describe("DisbursementsClient amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<DisbursementsClient applications={SUBSTRING_APPLICATIONS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setInput("Search ready to disburse", "50")
    expect(names()).toEqual(["Fifty Rand"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setInput("Search ready to disburse", "1500")
    expect(names()).toEqual(["Fifteen Hundred", "Fifteen Fifty"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setInput("Search ready to disburse", "1500.50")
    expect(names()).toEqual(["Fifteen Fifty"])
  })
})
