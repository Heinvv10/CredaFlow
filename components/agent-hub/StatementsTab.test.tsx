import { describe, it, expect } from "vitest"
import { StatementsTab, unknownAgentSentence } from "./StatementsTab"
import type { StatementGroup } from "@/lib/agent-hub/statement"
import type { SummaryTotals } from "@/lib/agent-hub/summary"

// StatementsTab carries no "use client", so it is a plain function returning a
// React element tree. Calling it directly and walking that tree needs no
// renderer and no DOM — the same pattern as
// app/(dashboard)/settings/audit-log/page.test.tsx. This is what makes the
// component's shape decision testable under `environment: "node"`.

type Element = { type: unknown; props: Record<string, unknown> }

function* walk(node: unknown): Generator<Element> {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  if (typeof node === "object" && "type" in node) {
    const el = node as { type: unknown; props?: Record<string, unknown> }
    const props = el.props ?? {}
    yield { type: el.type, props }
    yield* walk(props.children)
  }
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

const ZERO: SummaryTotals = { pendingCents: 0, payableCents: 0, paidCents: 0, reversedCents: 0, netOwedCents: 0 }

function group(agentId: string, agentName: string, attributed = true): StatementGroup {
  return {
    agentId,
    agentName,
    attributed,
    rows: [{
      id: `row-${agentId}`,
      createdAt: "2026-08-01T00:00:00.000Z",
      agentId: attributed ? agentId : null,
      agentName,
      agentResolved: attributed,
      borrower: null,
      principalCents: 100000,
      commissionCents: 5000,
      commissionStatus: "PENDING",
    }],
    totals: { ...ZERO, pendingCents: 5000, netOwedCents: 5000 },
  }
}

function render(overrides: Partial<Parameters<typeof StatementsTab>[0]> = {}) {
  const tree = StatementsTab({
    agents: [],
    selection: { kind: "some", agentIds: ["a1"] },
    periodFrom: "2026-08-01",
    periodTo: "2026-08-31",
    groups: [group("a1", "Agent One")],
    totals: { ...ZERO, pendingCents: 5000, netOwedCents: 5000 },
    requestedAgentCount: 1,
    unknownAgentIds: [],
    ...overrides,
  })
  const elements = [...walk(tree)]
  return {
    headers: elements.filter((e) => e.type === "th").map((e) => textOf(e.props.children)),
    text: textOf(tree),
  }
}

describe("StatementsTab shape", () => {
  it("uses the compact shape for one requested agent with their own rows", () => {
    expect(render().headers).toEqual(["Date", "Borrower", "Product", "Principal", "Commission", "Status"])
  })

  // THE REGRESSION GUARD. The component and the export route once derived this
  // separately — the component from `groups`, the route from the roster — and
  // disagreed here: two agents requested, only one with events in the period
  // rendered a single-agent table on screen and a multi-agent workbook in the
  // download, for the same query. Reverting this component to its own
  // `groups.length > 1` expression must fail this test.
  it("attributes when more agents were REQUESTED than have rows in the period", () => {
    const { headers } = render({
      selection: { kind: "some", agentIds: ["a1", "a2"] },
      requestedAgentCount: 2,
      groups: [group("a1", "Agent One")],
    })
    expect(headers[0]).toBe("Agent")
    expect(headers).toHaveLength(7)
  })

  it("attributes when the rows span more than one agent", () => {
    const { headers } = render({
      requestedAgentCount: 1,
      groups: [group("a1", "Agent One"), group("a2", "Agent Two")],
    })
    expect(headers[0]).toBe("Agent")
  })

  it("attributes when the only group is not a resolvable payee", () => {
    // Otherwise an orphan's money renders under the compact shape and reads as
    // though it belongs to the agent named in the picker.
    const { headers } = render({
      requestedAgentCount: 1,
      groups: [group("__unknown__", "Unassigned", false)],
    })
    expect(headers[0]).toBe("Agent")
  })

  it("warns, with a count, when the export will refuse the selection", () => {
    const { text } = render({ unknownAgentIds: ["ghost-1", "ghost-2"] })
    // An independent literal, NOT unknownAgentSentence(2) — an expected value
    // built by calling the code under test cannot detect a wrong implementation.
    expect(text).toContain(
      "2 selected agents are no longer on this tenant\u2019s roster, so their rows are not included below and Export to Excel will refuse this selection.",
    )
    // The raw ids are caller-supplied but must not be echoed back into the page.
    expect(text).not.toContain("ghost-1")
  })

  it("labels each agent option with the name alone", () => {
    // No money in the picker: the only figure available here is all-time, while
    // the statement below is period-scoped, so showing it put two different
    // numbers for the same agent on one screen — on a surface people pay from.
    const tree = StatementsTab({
      agents: [{ agentId: "a1", agentName: "Agent One" }, { agentId: "a2", agentName: "Amos Mockery" }],
      selection: { kind: "none" },
      periodFrom: "2026-08-01",
      periodTo: "2026-08-31",
      groups: [],
      totals: ZERO,
      requestedAgentCount: 0,
      unknownAgentIds: [],
    })
    const options = [...walk(tree)].filter((e) => e.type === "option").map((e) => textOf(e.props.children))
    expect(options).toEqual(["All agents", "Agent One", "Amos Mockery"])
    expect(options.join(" ")).not.toMatch(/R\s|owed|all time/)
  })

  it("prompts rather than rendering a table when nothing is selected", () => {
    const { headers, text } = render({ selection: { kind: "none" }, requestedAgentCount: 0, groups: [] })
    expect(headers).toEqual([])
    expect(text).toContain("Select one or more agents above")
  })

  it("explains the cap instead of rendering a table when too many agents are selected", () => {
    const { headers, text } = render({ selection: { kind: "too-many", count: 250 }, requestedAgentCount: 0, groups: [] })
    expect(headers).toEqual([])
    expect(text).toContain("250")
  })
})

describe("unknownAgentSentence", () => {
  // These read as trivial. They exist because the interleaved-JSX form of this
  // sentence rendered "agent isno longer" in the production build while the
  // element tree — and therefore every test above — kept the space. Asserting
  // the whole sentence as one string is what makes the wording checkable at all.
  it("reads correctly in the singular", () => {
    expect(unknownAgentSentence(1)).toBe(
      "1 selected agent is no longer on this tenant\u2019s roster, so their rows are not included below and Export to Excel will refuse this selection.",
    )
  })

  it("reads correctly in the plural", () => {
    expect(unknownAgentSentence(3)).toBe(
      "3 selected agents are no longer on this tenant\u2019s roster, so their rows are not included below and Export to Excel will refuse this selection.",
    )
  })

  it("renders nothing for a count the caller should never pass", () => {
    // Not reachable today (the caller guards on length > 0). Asserted because
    // the function is exported: a false sentence is worse than no sentence.
    expect(unknownAgentSentence(0)).toBe("")
    expect(unknownAgentSentence(-1)).toBe("")
    expect(unknownAgentSentence(1.5)).toBe("")
  })

  it("never runs two words together", () => {
    for (const count of [1, 2, 7]) {
      expect(unknownAgentSentence(count)).not.toMatch(/\b(is|are)no\b/)
      expect(unknownAgentSentence(count)).toMatch(/\b(is|are) no longer\b/)
    }
  })
})
