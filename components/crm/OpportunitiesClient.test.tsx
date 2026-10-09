import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpportunitiesClient } from "./OpportunitiesClient"

// next/link touches requestIdleCallback/`self` on mount, which the node test
// environment does not provide.
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function opportunity(overrides: Partial<Parameters<typeof OpportunitiesClient>[0]["opportunities"][number]> = {}) {
  return {
    id: "o1",
    clientId: "c1",
    type: "CREDIT_LIFE",
    status: "PENDING",
    assignedToId: null,
    notes: null,
    createdAt: new Date("2026-08-01"),
    client: {
      id: "c1",
      firstName: "Lesedi",
      lastName: "Mabtest",
      phone: "0821234567",
      loans: [{ principal: 200_000, status: "ACTIVE" }], // R2,000.00 in cents
    },
    ...overrides,
  }
}

const OPPORTUNITIES = [
  opportunity(),
  opportunity({
    id: "o2",
    clientId: "c2",
    type: "PERSONAL_LOAN",
    status: "CONTACTED",
    client: { id: "c2", firstName: "Amos", lastName: "Mockery", phone: "0820000004", loans: [{ principal: 65_000, status: "ACTIVE" }] },
  }),
  opportunity({
    id: "o3",
    clientId: "c3",
    type: "FUNERAL_COVER",
    status: "CONVERTED",
    client: { id: "c3", firstName: "Bonga", lastName: "Jester", phone: "0820000005", loans: [] },
  }),
]

let renderer: ReactTestRenderer

function childText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(childText).join("")
  if (value && typeof value === "object" && "children" in value) {
    return childText((value as { children?: unknown }).children)
  }
  return ""
}

function names(): string[] {
  return renderer.root
    .findAllByType("p")
    .filter((p) => typeof p.props.className === "string" && p.props.className.includes("font-semibold"))
    .map((p) => childText(p.props.children))
}

function setValue(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

describe("OpportunitiesClient filters", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<OpportunitiesClient opportunities={OPPORTUNITIES} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every opportunity before filtering", () => {
    expect(names()).toEqual(["Lesedi Mabtest", "Amos Mockery", "Bonga Jester"])
  })

  it("searches on client name", () => {
    setValue("Search opportunities", "mockery")
    expect(names()).toEqual(["Amos Mockery"])
  })

  it("searches on product/type label", () => {
    setValue("Search opportunities", "funeral")
    expect(names()).toEqual(["Bonga Jester"])
  })

  // Money is stored in cents on the client's loans; staff type the rand figure they see.
  it("searches on the rand amount, not the cent amount", () => {
    setValue("Search opportunities", "650")
    expect(names()).toEqual(["Amos Mockery"])
    setValue("Search opportunities", "65000")
    expect(names()).toEqual([])
  })

  it("existing type select still filters by type", () => {
    setValue("Filter by type", "PERSONAL_LOAN")
    expect(names()).toEqual(["Amos Mockery"])
  })

  it("existing status tabs still filter by status", () => {
    const tab = renderer.root.findAllByType("button").find((b) => b.props.children[0] === "Converted")
    expect(tab).toBeTruthy()
    act(() => {
      tab!.props.onClick()
    })
    expect(names()).toEqual(["Bonga Jester"])
  })

  it("combines search with type select and a non-default tab", () => {
    setValue("Filter by type", "CREDIT_LIFE")
    const tab = renderer.root.findAllByType("button").find((b) => b.props.children[0] === "Pending")
    act(() => {
      tab!.props.onClick()
    })
    setValue("Search opportunities", "lesedi")
    expect(names()).toEqual(["Lesedi Mabtest"])

    // Narrowing further to a mismatched name empties the result.
    setValue("Search opportunities", "mockery")
    expect(names()).toEqual([])
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// client's opportunity also returned both larger ones. Client phone numbers
// are dropped here — a phone containing "50" is not searched, but keeping
// them varied avoids any accidental collision.
const SUBSTRING_OPPORTUNITIES = [
  opportunity({ id: "s1", clientId: "c1", client: { id: "c1", firstName: "Fifty", lastName: "Rand", phone: "0820000000", loans: [{ principal: 5_000, status: "ACTIVE" }] } }),
  opportunity({ id: "s2", clientId: "c2", client: { id: "c2", firstName: "Six", lastName: "Fifty", phone: "0820000001", loans: [{ principal: 65_000, status: "ACTIVE" }] } }),
  opportunity({ id: "s3", clientId: "c3", client: { id: "c3", firstName: "Fifteen", lastName: "Hundred", phone: "0820000002", loans: [{ principal: 150_000, status: "ACTIVE" }] } }),
  opportunity({ id: "s4", clientId: "c4", client: { id: "c4", firstName: "Fifteen", lastName: "Fifty", phone: "0820000003", loans: [{ principal: 150_050, status: "ACTIVE" }] } }),
]

describe("OpportunitiesClient amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(<OpportunitiesClient opportunities={SUBSTRING_OPPORTUNITIES} />)
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setValue("Search opportunities", "50")
    expect(names()).toEqual(["Fifty Rand"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setValue("Search opportunities", "1500")
    expect(names()).toEqual(["Fifteen Hundred", "Fifteen Fifty"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setValue("Search opportunities", "1500.50")
    expect(names()).toEqual(["Fifteen Fifty"])
  })
})
