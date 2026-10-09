import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InsuranceDashboardClient } from "./InsuranceDashboardClient"

// next/link touches requestIdleCallback/`self` on mount, which the node test
// environment does not provide.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function policy(overrides: Partial<Parameters<typeof InsuranceDashboardClient>[0]["policies"][number]> = {}) {
  return {
    id: "p1",
    policyNumber: "POL-AAA",
    type: "FUNERAL_COVER",
    status: "ACTIVE",
    premiumAmount: 250, // rand, not cents
    sumAssured: 20_000,
    commissionAmount: 25,
    renewalDate: new Date("2027-01-01"),
    insurer: "Guardrisk",
    client: { firstName: "Lesedi", lastName: "Mabtest", phone: "0820000000" },
    claims: [],
    ...overrides,
  }
}

const POLICIES = [
  policy(),
  policy({
    id: "p2",
    policyNumber: "POL-BBB",
    type: "CREDIT_LIFE",
    status: "LAPSED",
    client: { firstName: "Amos", lastName: "Mockery", phone: "0821111111" },
    premiumAmount: 65,
    sumAssured: 5_000,
  }),
  policy({
    id: "p3",
    policyNumber: "POL-CCC",
    type: "FUNERAL_COVER",
    status: "ACTIVE",
    client: { firstName: "Bonga", lastName: "Jester", phone: "0822222222" },
    premiumAmount: 150,
    sumAssured: 10_000,
  }),
]

let renderer: ReactTestRenderer

function policyNumbers(): string[] {
  return renderer.root
    .findAllByType("a")
    .filter((a) => typeof a.props.href === "string" && a.props.href.startsWith("/insurance/") && a.props.href !== "/insurance/claims" && a.props.href !== "/insurance/new")
    .map((a) => a.props.children)
    .filter((text): text is string => typeof text === "string" && text.startsWith("POL-"))
}

function setInput(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

function clickTab(label: string) {
  const el = renderer.root.findAllByType("button").find((b) => {
    const first = b.props.children?.[0]
    return first === label
  })
  act(() => {
    el?.props.onClick()
  })
}

function tabBadge(label: string): number {
  const btn = renderer.root.findAllByType("button").find((b) => b.props.children?.[0] === label)
  const span = btn?.findByType("span")
  return span?.props.children
}

function selectOptionValues(label: string): string[] {
  return renderer.root
    .findByProps({ "aria-label": label })
    .findAllByType("option")
    .map((o) => o.props.value)
}

// Extracts the actual text content of the rendered tree, not a dump of the
// react-test-renderer JSON — asserting on copy the way a person reading the
// screen would, not on serialized node shape.
function renderedText(): string {
  const collect = (node: unknown): string[] => {
    if (typeof node === "string") return [node]
    if (typeof node === "number") return [String(node)]
    if (Array.isArray(node)) return node.flatMap(collect)
    if (node && typeof node === "object" && "children" in node) {
      return collect((node as { children: unknown }).children)
    }
    return []
  }
  return collect(renderer.toJSON()).join(" ")
}

describe("InsuranceDashboardClient filters", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(
        <InsuranceDashboardClient
          policies={POLICIES}
          claims={[]}
          monthlyPremiums={465}
          commissionEarned={25}
          openClaims={0}
          totalCollected={0}
        />
      )
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every policy before filtering", () => {
    expect(policyNumbers()).toEqual(["POL-AAA", "POL-BBB", "POL-CCC"])
  })

  it("searches on client name", () => {
    setInput("Search policies", "mockery")
    expect(policyNumbers()).toEqual(["POL-BBB"])
  })

  it("searches on policy number", () => {
    setInput("Search policies", "pol-ccc")
    expect(policyNumbers()).toEqual(["POL-CCC"])
  })

  // premiumAmount/sumAssured are already rand (Decimal) values on
  // InsurancePolicy, unlike Loan.principal which is cents — no /100 needed.
  it("searches on the rand amount", () => {
    setInput("Search policies", "250")
    expect(policyNumbers()).toEqual(["POL-AAA"])
  })

  it("filters by status", () => {
    setInput("Filter by status", "LAPSED")
    expect(policyNumbers()).toEqual(["POL-BBB"])
  })

  it("combines search with a non-default tab", () => {
    clickTab("FUNERAL")
    setInput("Search policies", "bonga")
    expect(policyNumbers()).toEqual(["POL-CCC"])
  })

  it("shows unfiltered tab badge counts identical to the old unfiltered totals", () => {
    expect(tabBadge("ALL")).toBe(3)
    expect(tabBadge("FUNERAL")).toBe(2)
    expect(tabBadge("CREDIT LIFE")).toBe(1)
    expect(tabBadge("LIFE")).toBe(0)
  })

  // FUNERAL has POL-AAA (Lesedi) and POL-CCC (Bonga). Searching for Lesedi
  // must shrink the FUNERAL badge from 2 to 1, not leave it claiming a row
  // the search has hidden.
  it("shrinks a tab badge when a search excludes rows in that tab", () => {
    setInput("Search policies", "lesedi")
    expect(tabBadge("FUNERAL")).toBe(1)
    expect(tabBadge("ALL")).toBe(1)
    expect(tabBadge("CREDIT LIFE")).toBe(0)
  })

  // Regression: status options used to be scoped to the active tab. LAPSED
  // only exists on POL-BBB (CREDIT LIFE). Selecting it, then switching to a
  // tab with no LAPSED rows, must not silently fall back to option[0]
  // ("All statuses") while `status` state keeps filtering by LAPSED — the
  // <select> fallback bug that has recurred in this codebase.
  it("keeps the selected status bound after switching to a tab with no matching rows", () => {
    setInput("Filter by status", "LAPSED")
    clickTab("FUNERAL")

    const select = renderer.root.findByProps({ "aria-label": "Filter by status" })
    expect(select.props.value).toBe("LAPSED")
    expect(selectOptionValues("Filter by status")).toContain("LAPSED")
  })

  it("shows the filtered-empty state and a visible active-filter affordance when the selected status has no rows in the tab", () => {
    setInput("Filter by status", "LAPSED")
    clickTab("FUNERAL")

    const text = renderedText()
    expect(text).toContain("No policies match these filters")
    expect(text).toContain("Clear filters")
    // FilterSummary above the table renders "0" / "of" / "2" / "policies" /
    // "match" as separate JSX text nodes, so match on the normalized text
    // (collapsed whitespace) rather than the exact node boundaries.
    expect(text.replace(/\s+/g, " ")).toContain("0 of 2 policies match")
    expect(text).toContain("Clear")
  })

  it("keeps the same status option set across tabs", () => {
    const allTabOptions = selectOptionValues("Filter by status")
    clickTab("FUNERAL")
    const funeralTabOptions = selectOptionValues("Filter by status")
    expect(funeralTabOptions).toEqual(allTabOptions)
    expect(funeralTabOptions).toEqual(["ALL", "ACTIVE", "LAPSED"])
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// premium also returned both larger ones. These amounts are RANDS, not cents.
// Policy numbers carry no digits — one would satisfy the text match and mask
// the amount behaviour. sumAssured values are kept clear of the queries so
// only premiumAmount decides each case.
const SUBSTRING_POLICIES = [
  policy({ id: "s1", policyNumber: "POL-AAA", premiumAmount: 50, sumAssured: 9_999 }),
  policy({ id: "s2", policyNumber: "POL-BBB", premiumAmount: 650, sumAssured: 9_998 }),
  policy({ id: "s3", policyNumber: "POL-CCC", premiumAmount: 1_500, sumAssured: 9_997 }),
  policy({ id: "s4", policyNumber: "POL-DDD", premiumAmount: 1_500.5, sumAssured: 9_996 }),
]

describe("InsuranceDashboardClient amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(
        <InsuranceDashboardClient
          policies={SUBSTRING_POLICIES}
          claims={[]}
          monthlyPremiums={0}
          commissionEarned={0}
          openClaims={0}
          totalCollected={0}
        />
      )
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setInput("Search policies", "50")
    expect(policyNumbers()).toEqual(["POL-AAA"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setInput("Search policies", "1500")
    expect(policyNumbers()).toEqual(["POL-CCC", "POL-DDD"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setInput("Search policies", "1500.50")
    expect(policyNumbers()).toEqual(["POL-DDD"])
  })
})
