import { describe, expect, it } from "vitest"
import { ALL_AGENTS, MAX_SELECTED_AGENTS, parseAgentSelection, selectedOptionValues } from "./agent-selection"

describe("parseAgentSelection", () => {
  it("treats an absent selector as 'none', never as 'all'", () => {
    // The load-bearing case: if absence resolved to "all", loading the tab with
    // no agent chosen would export every agent's commission history.
    expect(parseAgentSelection(undefined)).toEqual({ kind: "none" })
  })

  it("treats blank and whitespace-only values as 'none'", () => {
    expect(parseAgentSelection("")).toEqual({ kind: "none" })
    expect(parseAgentSelection("   ")).toEqual({ kind: "none" })
    expect(parseAgentSelection(["", "  "])).toEqual({ kind: "none" })
  })

  it("reads a single agent id (Next collapses one occurrence to a string)", () => {
    expect(parseAgentSelection("agent-a")).toEqual({ kind: "some", agentIds: ["agent-a"] })
  })

  it("reads several agent ids from repeated params", () => {
    expect(parseAgentSelection(["agent-a", "agent-b"])).toEqual({ kind: "some", agentIds: ["agent-a", "agent-b"] })
  })

  it("recognises the all-agents sentinel", () => {
    expect(parseAgentSelection(ALL_AGENTS)).toEqual({ kind: "all" })
  })

  it("widens to 'all' when the sentinel is co-selected with specific agents", () => {
    // Ctrl-clicking "All agents" plus two names submits all three values. The
    // widest reading is what the UI visibly promised.
    expect(parseAgentSelection([ALL_AGENTS, "agent-a", "agent-b"])).toEqual({ kind: "all" })
    expect(parseAgentSelection(["agent-a", ALL_AGENTS])).toEqual({ kind: "all" })
  })

  it("trims surrounding whitespace on ids", () => {
    expect(parseAgentSelection([" agent-a ", "agent-b"])).toEqual({ kind: "some", agentIds: ["agent-a", "agent-b"] })
  })

  it("de-duplicates repeated ids so an agent cannot be counted twice", () => {
    // A duplicate would otherwise double that agent's rows in the workbook and
    // double-count their subtotal against the grand total.
    expect(parseAgentSelection(["agent-a", "agent-a", "agent-b"])).toEqual({
      kind: "some",
      agentIds: ["agent-a", "agent-b"],
    })
  })

  it("de-duplicates only after trimming, so ' a' and 'a' are one agent", () => {
    expect(parseAgentSelection([" agent-a", "agent-a "])).toEqual({ kind: "some", agentIds: ["agent-a"] })
  })

  it("accepts a selection exactly at the cap", () => {
    const ids = Array.from({ length: MAX_SELECTED_AGENTS }, (_, i) => `agent-${i}`)
    expect(parseAgentSelection(ids)).toEqual({ kind: "some", agentIds: ids })
  })

  it("rejects a selection over the cap rather than building an unbounded query", () => {
    const ids = Array.from({ length: MAX_SELECTED_AGENTS + 1 }, (_, i) => `agent-${i}`)
    expect(parseAgentSelection(ids)).toEqual({ kind: "too-many", count: MAX_SELECTED_AGENTS + 1 })
  })

  it("counts the cap AFTER de-duplication, so one agent repeated is not a rejection", () => {
    const ids = Array.from({ length: MAX_SELECTED_AGENTS + 50 }, () => "agent-a")
    expect(parseAgentSelection(ids)).toEqual({ kind: "some", agentIds: ["agent-a"] })
  })

  it("does not treat the sentinel as a selectable agent id", () => {
    const selection = parseAgentSelection([ALL_AGENTS])
    expect(selection.kind).toBe("all")
    expect(selection).not.toHaveProperty("agentIds")
  })
})

describe("selectedOptionValues", () => {
  it("marks only the sentinel selected for 'all'", () => {
    expect(selectedOptionValues({ kind: "all" })).toEqual([ALL_AGENTS])
  })

  it("marks the chosen agents selected for 'some'", () => {
    expect(selectedOptionValues({ kind: "some", agentIds: ["a", "b"] })).toEqual(["a", "b"])
  })

  it("marks nothing selected for 'none'", () => {
    expect(selectedOptionValues({ kind: "none" })).toEqual([])
  })

  it("round-trips a parsed selection back to the option values that produced it", () => {
    expect(selectedOptionValues(parseAgentSelection(["a", "b"]))).toEqual(["a", "b"])
    expect(selectedOptionValues(parseAgentSelection(ALL_AGENTS))).toEqual([ALL_AGENTS])
  })
})
