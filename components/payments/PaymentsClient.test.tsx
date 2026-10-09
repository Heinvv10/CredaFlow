import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PaymentsClient } from "./PaymentsClient"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function payment(overrides: Partial<Parameters<typeof PaymentsClient>[0]["allocated"][number]> = {}) {
  return {
    id: "p1",
    loanId: "l1",
    amount: 200_000, // R2,000.00 in cents
    paymentMethod: "EFT",
    reference: "PMT-AAA",
    notes: null,
    capturedBy: null,
    receivedAt: "2026-08-01T10:00:00.000Z",
    reversed: false,
    reversedAt: null,
    reversalReason: null,
    allocationStatus: "ALLOCATED" as const,
    reconciliationReason: null,
    reconciliationReference: null,
    reconciledAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    loan: {
      id: "l1",
      reference: "LN-AAA",
      outstandingPrincipal: 100_000,
      client: { firstName: "Lesedi", lastName: "Mabtest" },
    },
    ...overrides,
  }
}

const ALLOCATED = [
  payment(),
  payment({
    id: "p2",
    reference: "PMT-BBB",
    paymentMethod: "CASH",
    amount: 65_000,
    loan: { id: "l2", reference: "LN-BBB", outstandingPrincipal: 50_000, client: { firstName: "Amos", lastName: "Mockery" } },
  }),
]

const UNAPPLIED = [
  payment({
    id: "p3",
    reference: "PMT-CCC",
    allocationStatus: "UNAPPLIED" as const,
    amount: 42_000,
    loan: { id: "l3", reference: "LN-CCC", outstandingPrincipal: 0, client: { firstName: "Bonga", lastName: "Jester" } },
  }),
]

const RESOLVED = [
  payment({
    id: "p4",
    reference: "PMT-DDD",
    allocationStatus: "REFUNDED" as const,
    amount: 30_000,
    reconciliationReason: "duplicate",
    loan: { id: "l4", reference: "LN-DDD", outstandingPrincipal: 0, client: { firstName: "Nomsa", lastName: "Khumalo" } },
  }),
]

let renderer: ReactTestRenderer

// Loan reference renders as a link in Allocated/Unapplied but plain text in
// Refunded/Reversed, so scan every td for the "LN-" text directly.
function references(): string[] {
  return renderer.root
    .findAllByType("tr")
    .flatMap((row) => {
      for (const td of row.findAllByType("td")) {
        const link = td.findAllByType("a")[0]
        const text = link ? link.children[0] : td.children[0]
        if (typeof text === "string" && text.startsWith("LN-")) return [text]
      }
      return []
    })
}

function setInput(label: string, value: string) {
  const el = renderer.root.findByProps({ "aria-label": label })
  act(() => {
    el.props.onChange({ target: { value } })
  })
}

function clickTab(label: string) {
  const button = renderer.root.findAllByType("button").find((b) => {
    const child = b.children[0]
    return typeof child === "string" && child === label
  })
  act(() => {
    button?.props.onClick()
  })
}

describe("PaymentsClient search", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={ALLOCATED}
          allocatedCount={ALLOCATED.length}
          unapplied={UNAPPLIED}
          resolved={RESOLVED}
          resolvedCount={RESOLVED.length}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={200}
        />,
      )
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("shows every allocated payment before filtering", () => {
    expect(references()).toEqual(["LN-AAA", "LN-BBB"])
  })

  it("searches on client name", () => {
    setInput("Search payments", "mockery")
    expect(references()).toEqual(["LN-BBB"])
  })

  it("searches on payment reference", () => {
    setInput("Search payments", "pmt-bbb")
    expect(references()).toEqual(["LN-BBB"])
  })

  // Money is stored in cents; staff type the rand figure they can see.
  it("searches on the rand amount, not the cent amount", () => {
    setInput("Search payments", "650")
    expect(references()).toEqual(["LN-BBB"])
    setInput("Search payments", "65000")
    expect(references()).toEqual([])
  })

  it("filters by payment method", () => {
    setInput("Filter by payment method", "CASH")
    expect(references()).toEqual(["LN-BBB"])
  })

  it("searches within the unapplied tab", () => {
    clickTab("Needs Reconciliation")
    expect(references()).toEqual(["LN-CCC"])
    setInput("Search payments", "khumalo")
    expect(references()).toEqual([])
    setInput("Search payments", "jester")
    expect(references()).toEqual(["LN-CCC"])
  })

  it("searches within the resolved tab, combined with the non-default tab", () => {
    clickTab("Refunded / Reversed")
    expect(references()).toEqual(["LN-DDD"])
    setInput("Search payments", "khumalo")
    expect(references()).toEqual(["LN-DDD"])
    setInput("Search payments", "mockery")
    expect(references()).toEqual([])
  })
})

// Collects every rendered text leaf, joined with spaces — React splits
// interpolated JSX ({rowCap} of {allocatedCount} …) into separate text
// nodes, so asserting on a serialised tree (JSON.stringify(toJSON())) can
// pass on a coincidental substring match without the text actually having
// rendered as a sentence. Walking and joining catches that.
function pageText(r: ReactTestRenderer): string {
  function collect(node: unknown): string {
    if (typeof node === "string") return node
    if (Array.isArray(node)) return node.map(collect).join(" ")
    if (node && typeof node === "object" && "children" in node) {
      const children = (node as { children?: unknown[] }).children
      return (children ?? []).map(collect).join(" ")
    }
    return ""
  }
  return collect(r.toJSON())
}

describe("PaymentsClient search — truncated period + no matches", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  // Allocated tab: the page only ever loaded `rowCap` of `allocatedCount`
  // rows for the period. A search that matches none of the LOADED rows must
  // still say only a subset was searched — otherwise "no match" reads as
  // "this payment does not exist" when it may simply be one of the rows the
  // period truncation never brought to the client.
  it("allocated tab: truncated period + no match warns that only a subset was searched", () => {
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={ALLOCATED}
          allocatedCount={ALLOCATED.length + 3}
          unapplied={UNAPPLIED}
          resolved={RESOLVED}
          resolvedCount={RESOLVED.length}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={ALLOCATED.length}
        />,
      )
    })
    setInput("Search payments", "nonexistent-client")
    const text = pageText(renderer)
    expect(text).toContain("No payments match your search.")
    expect(text).toContain("were searched")
    expect(text).toContain("narrow the period to search the other  3")
  })

  it("allocated tab: untruncated period + no match does NOT claim a search was partial", () => {
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={ALLOCATED}
          allocatedCount={ALLOCATED.length}
          unapplied={UNAPPLIED}
          resolved={RESOLVED}
          resolvedCount={RESOLVED.length}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={200}
        />,
      )
    })
    setInput("Search payments", "nonexistent-client")
    const text = pageText(renderer)
    expect(text).toContain("No payments match your search.")
    expect(text).not.toContain("were searched")
  })

  it("resolved tab: truncated period + no match warns that only a subset was searched", () => {
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={ALLOCATED}
          allocatedCount={ALLOCATED.length}
          unapplied={UNAPPLIED}
          resolved={RESOLVED}
          resolvedCount={RESOLVED.length + 4}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={RESOLVED.length}
        />,
      )
    })
    clickTab("Refunded / Reversed")
    setInput("Search payments", "nonexistent-client")
    const text = pageText(renderer)
    expect(text).toContain("No payments match your search.")
    expect(text).toContain("were searched")
    expect(text).toContain("narrow the period to search the other  4")
  })

  it("resolved tab: untruncated period + no match does NOT claim a search was partial", () => {
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={ALLOCATED}
          allocatedCount={ALLOCATED.length}
          unapplied={UNAPPLIED}
          resolved={RESOLVED}
          resolvedCount={RESOLVED.length}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={200}
        />,
      )
    })
    clickTab("Refunded / Reversed")
    setInput("Search payments", "nonexistent-client")
    const text = pageText(renderer)
    expect(text).toContain("No payments match your search.")
    expect(text).not.toContain("were searched")
  })
})

// R50 sits inside R650 and R1,500 as a substring. The first version of this
// filter matched `String(rands).includes(digits)`, so searching for the R50
// receipt also returned both larger ones. Payment and loan references carry
// no digits here — either would satisfy the text match and mask the amount
// behaviour.
const SUBSTRING_ALLOCATED = [
  payment({ id: "s1", reference: "PMT-AAA", amount: 5_000, loan: { id: "l1", reference: "LN-AAA", outstandingPrincipal: 0, client: { firstName: "Fifty", lastName: "Rand" } } }),
  payment({ id: "s2", reference: "PMT-BBB", amount: 65_000, loan: { id: "l2", reference: "LN-BBB", outstandingPrincipal: 0, client: { firstName: "Six", lastName: "Fifty" } } }),
  payment({ id: "s3", reference: "PMT-CCC", amount: 150_000, loan: { id: "l3", reference: "LN-CCC", outstandingPrincipal: 0, client: { firstName: "Fifteen", lastName: "Hundred" } } }),
  payment({ id: "s4", reference: "PMT-DDD", amount: 150_050, loan: { id: "l4", reference: "LN-DDD", outstandingPrincipal: 0, client: { firstName: "Fifteen", lastName: "Fifty" } } }),
]

describe("PaymentsClient amount search is exact, not substring", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={SUBSTRING_ALLOCATED}
          allocatedCount={SUBSTRING_ALLOCATED.length}
          unapplied={[]}
          resolved={[]}
          resolvedCount={0}
          periodLabel="this month"
          periodQuery="period=month"
          rowCap={200}
        />,
      )
    })
  })

  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("does not return larger amounts that merely contain the digits", () => {
    setInput("Search payments", "50")
    expect(references()).toEqual(["LN-AAA"])
  })

  it("matches every cent value inside a whole-rand query", () => {
    setInput("Search payments", "1500")
    expect(references()).toEqual(["LN-CCC", "LN-DDD"])
  })

  it("matches the exact cent value when the query names cents", () => {
    setInput("Search payments", "1500.50")
    expect(references()).toEqual(["LN-DDD"])
  })
})

describe("PaymentsClient reconciliation queue", () => {
  afterEach(() => {
    act(() => renderer.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  it("R4-4: shows a receipt held because default charges refused it, with a reason staff can act on", () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const held = payment({
      id: "p9", reference: "STITCH-9", allocationStatus: "UNAPPLIED" as const, amount: 10_000,
      reconciliationReason: "charges_refused",
      loan: { id: "l9", reference: "LN-HELD", outstandingPrincipal: 0, client: { firstName: "Zola", lastName: "Dube" } },
    })
    act(() => {
      renderer = create(
        <PaymentsClient
          allocated={[]} allocatedCount={0} unapplied={[held]} resolved={[]} resolvedCount={0}
          periodLabel="this month" periodQuery="period=month" rowCap={200}
        />,
      )
    })
    clickTab("Needs Reconciliation")
    expect(references()).toEqual(["LN-HELD"])
    const cells = renderer.root.findAllByType("td").flatMap((td) => td.children).filter((c) => typeof c === "string")
    expect(cells).toContain("Held: default charges could not be booked — allocate once resolved")
  })
})
