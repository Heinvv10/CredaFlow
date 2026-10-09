import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CollectionsTabs } from "./CollectionsTabs"

// next/link touches requestIdleCallback/`self` on mount, which the node test
// environment does not provide.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

// The row-action buttons pull in useRouter/toast/modals unrelated to search
// filtering — stub them so the test stays focused on CollectionsTabs itself.
vi.mock("./Section129Button", () => ({ Section129Button: () => <span>S129</span> }))
vi.mock("./LogContactButton", () => ({ LogContactButton: () => <span>LogContact</span> }))
vi.mock("./PaymentPlanButton", () => ({ PaymentPlanButton: () => <span>PaymentPlan</span> }))
vi.mock("./CollectionsWaButton", () => ({ CollectionsWaButton: () => <span>WA</span> }))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function loan(overrides: Partial<Parameters<typeof CollectionsTabs>[0]["loans"][number]> = {}) {
  return {
    id: "l1",
    reference: "COL-AAA",
    clientId: "c1",
    daysInArrears: 5,
    arrearsAmount: 200_000, // R2,000.00 in cents
    client: { firstName: "Lesedi", lastName: "Mabtest", phone: "0820000000", whatsapp: null },
    product: { name: "Micro Loan", productType: "MICRO" },
    notes: [],
    paymentPlan: null,
    ...overrides,
  }
}

const LOANS = [
  loan(),
  loan({
    id: "l2",
    reference: "COL-BBB",
    daysInArrears: 45,
    arrearsAmount: 65_000,
    client: { firstName: "Amos", lastName: "Mockery", phone: "0820000001", whatsapp: null },
    product: { name: "Personal Loan", productType: "PERSONAL" },
  }),
  loan({
    id: "l3",
    reference: "COL-CCC",
    daysInArrears: 12,
    arrearsAmount: 150_000,
    client: { firstName: "Bonga", lastName: "Jester", phone: "0820000002", whatsapp: null },
    product: { name: "Personal Loan", productType: "PERSONAL" },
  }),
]

const TABS = [
  { key: "all", label: "All Overdue", count: LOANS.length },
  { key: "soft", label: "Soft (1-29)", count: 2 },
  { key: "hard", label: "Hard (30-59)", count: 1 },
  { key: "default", label: "Default Risk (60-89)", count: 0 },
  { key: "legal", label: "Legal (90+)", count: 0 },
]

let renderer: ReactTestRenderer

function references(): string[] {
  return renderer.root
    .findAllByType("a")
    .map((a) => a.props.children)
    .flatMap((c) => (typeof c === "string" && c.startsWith("COL-") ? [c] : []))
}

function setInput(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

function clickTab(label: string) {
  const tabButton = renderer.root
    .findAllByType("button")
    .find((b) => b.props.children[0] === label)
  act(() => {
    tabButton!.props.onClick()
  })
}

function badgeCount(label: string): number {
  const tabButton = renderer.root
    .findAllByType("button")
    .find((b) => b.props.children[0] === label)
  const badge = tabButton!.findAllByType("span")[0]
  return Number(badge.props.children)
}

function selectOptionValues(label: string): string[] {
  const select = renderer.root.findByProps({ "aria-label": label })
  return select.findAllByType("option").map((o) => o.props.value as string)
}

// Concatenated visible text, so assertions read against real copy the user
// sees rather than the renderer's internal JSON shape.
function renderedText(): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (node == null) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node === "string") {
      parts.push(node)
      return
    }
    if (typeof node === "object" && "children" in (node as { children?: unknown })) {
      walk((node as { children?: unknown }).children)
    }
  }
  walk(renderer.toJSON())
  return parts.join(" ")
}

describe("CollectionsTabs search", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<CollectionsTabs tabs={TABS} loans={LOANS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every loan in the active tab before filtering", () => {
    expect(references()).toEqual(["COL-AAA", "COL-BBB", "COL-CCC"])
  })

  it("searches on client name", () => {
    setInput("Search collections", "mockery")
    expect(references()).toEqual(["COL-BBB"])
  })

  it("searches on reference", () => {
    setInput("Search collections", "col-ccc")
    expect(references()).toEqual(["COL-CCC"])
  })

  // Money is stored in cents; staff type the rand figure they can see.
  it("searches on the rand amount, not the cent amount", () => {
    setInput("Search collections", "650")
    expect(references()).toEqual(["COL-BBB"])
    setInput("Search collections", "65000")
    expect(references()).toEqual([])
  })

  it("filters by product", () => {
    setInput("Filter by product", "PERSONAL")
    expect(references()).toEqual(["COL-BBB", "COL-CCC"])
  })

  it("combines search with a non-default tab", () => {
    clickTab("Hard (30-59)")
    expect(references()).toEqual(["COL-BBB"])
    setInput("Search collections", "mockery")
    expect(references()).toEqual(["COL-BBB"])
    setInput("Search collections", "jester")
    expect(references()).toEqual([])
  })

  it("keeps the existing DPD tabs working, unaffected by search", () => {
    setInput("Search collections", "col-")
    clickTab("Soft (1-29)")
    expect(references()).toEqual(["COL-AAA", "COL-CCC"])
  })

  it("shows the same badge counts as the server-supplied tabs when nothing is filtered", () => {
    expect(badgeCount("All Overdue")).toBe(3)
    expect(badgeCount("Soft (1-29)")).toBe(2)
    expect(badgeCount("Hard (30-59)")).toBe(1)
    expect(badgeCount("Default Risk (60-89)")).toBe(0)
    expect(badgeCount("Legal (90+)")).toBe(0)
  })

  it("shrinks a tab's badge when a search excludes rows in that tab", () => {
    // Soft (1-29) holds COL-AAA (Lesedi) and COL-CCC (Bonga); a name search
    // for Lesedi should leave only COL-AAA visible there.
    expect(badgeCount("Soft (1-29)")).toBe(2)
    setInput("Search collections", "lesedi")
    expect(badgeCount("Soft (1-29)")).toBe(1)
    // A badge for a tab holding no matches at all must show 0, not the
    // unfiltered total — Hard (30-59) holds only COL-BBB (Amos).
    expect(badgeCount("Hard (30-59)")).toBe(0)
  })

  // Regression: product options were previously derived from the ACTIVE TAB's
  // rows. Soft (1-29) has MICRO (COL-AAA) and PERSONAL (COL-CCC); Hard (30-59)
  // has only PERSONAL (COL-BBB). Picking MICRO on Soft, then switching to
  // Hard, used to leave `product` state pointing at a value with no matching
  // <option> — the <select> silently fell back to displaying option[0]
  // ("All products") while state kept filtering by MICRO, so a tab that
  // plainly has rows (COL-BBB) read as "no accounts match" while the visible
  // dropdown claimed no filter was on.
  it("keeps the product filter selected and visible when switching to a tab with no matching product", () => {
    setInput("Filter by product", "MICRO")
    clickTab("Hard (30-59)")

    const select = renderer.root.findByProps({ "aria-label": "Filter by product" })
    expect(select.props.value).toBe("MICRO")
    expect(selectOptionValues("Filter by product")).toContain("MICRO")

    // The row list is genuinely empty for this tab+filter combo (Hard only
    // has PERSONAL), but that must read as a FILTERED empty state, not the
    // "nothing in this bucket" state — Hard (30-59) does have a row.
    expect(references()).toEqual([])
    expect(renderedText()).toContain("No accounts match these filters")
    expect(renderedText()).not.toContain("No accounts in this category")

    // The filter-active affordance (summary + clear) must still be visible,
    // so the screen cannot read as "no filter applied".
    expect(renderedText()).toMatch(/0\s+of\s+1\s+accounts\s+match/)
    expect(renderedText()).toContain("Clear")
  })

  it("offers the same product options regardless of which tab is active", () => {
    const onAll = selectOptionValues("Filter by product")
    clickTab("Hard (30-59)")
    const onHard = selectOptionValues("Filter by product")
    expect(onHard.sort()).toEqual(onAll.sort())
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// account also returned both larger ones. References carry no digits here: a
// reference containing "50" would satisfy the text match and mask the amount
// behaviour. All four sit in the same DPD bucket so the tab cannot do the
// filtering for us.
const SUBSTRING_LOANS = [
  loan({ id: "s1", reference: "COL-AAA", daysInArrears: 5, arrearsAmount: 5_000 }),
  loan({ id: "s2", reference: "COL-BBB", daysInArrears: 5, arrearsAmount: 65_000 }),
  loan({ id: "s3", reference: "COL-CCC", daysInArrears: 5, arrearsAmount: 150_000 }),
  loan({ id: "s4", reference: "COL-DDD", daysInArrears: 5, arrearsAmount: 150_050 }),
]

const SUBSTRING_TABS = [
  { key: "all", label: "All Overdue", count: SUBSTRING_LOANS.length },
  { key: "soft", label: "Soft (1-29)", count: SUBSTRING_LOANS.length },
]

describe("CollectionsTabs amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<CollectionsTabs tabs={SUBSTRING_TABS} loans={SUBSTRING_LOANS} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setInput("Search collections", "50")
    expect(references()).toEqual(["COL-AAA"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setInput("Search collections", "1500")
    expect(references()).toEqual(["COL-CCC", "COL-DDD"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setInput("Search collections", "1500.50")
    expect(references()).toEqual(["COL-DDD"])
  })
})
