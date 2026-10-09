import { describe, it, expect } from "vitest"
import {
  buildStatementRows,
  centsToRands,
  groupStatementRows,
  isMultiAgentStatement,
  statementFilename,
  statementScopeName,
  UNASSIGNED_AGENT_NAME,
  UNKNOWN_AGENT_KEY,
  UNKNOWN_AGENT_NAME,
  type StatementRow,
} from "./statement"

const loansById = new Map([
  ["L1", { id: "L1", reference: "LN-0001", client: { firstName: "Nhlanhla", lastName: "Mocktest" }, product: { name: "Micro Loan" } }],
])

const agentNameById = new Map([
  ["A1", "Test Agent One"],
  ["A2", "Amos Mockery"],
])

describe("buildStatementRows", () => {
  it("shapes a row, resolves its borrower, and names its agent", () => {
    const rows = buildStatementRows(
      [{
        id: "e1",
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        agentId: "A1",
        amountCents: 500000,
        commissionCents: 5000,
        commissionStatus: "PAYABLE",
        metadata: { loanId: "L1" },
      }],
      loansById,
      agentNameById,
    )
    expect(rows).toEqual([{
      id: "e1",
      createdAt: "2026-08-01T10:00:00.000Z",
      agentId: "A1",
      agentName: "Test Agent One",
      agentResolved: true,
      borrower: { loanId: "L1", clientName: "Nhlanhla Mocktest", loanReference: "LN-0001", productName: "Micro Loan" },
      principalCents: 500000,
      commissionCents: 5000,
      commissionStatus: "PAYABLE",
    }])
  })

  // Same degrade-to-null rule as resolveBorrower itself: a row for an event
  // with no resolvable loan must still render, not disappear or throw.
  it("carries a null borrower rather than dropping the row", () => {
    const rows = buildStatementRows(
      [{ id: "e2", createdAt: new Date("2026-08-01T00:00:00.000Z"), agentId: "A1", amountCents: null, commissionCents: null, commissionStatus: "PENDING", metadata: {} }],
      loansById,
      agentNameById,
    )
    expect(rows[0].borrower).toBeNull()
  })

  it("labels an unresolvable agent rather than rendering an empty name", () => {
    // An empty cell in the Agent column reads like a formatting glitch; a payout
    // must never be made against a blank payee.
    const rows = buildStatementRows(
      [
        { id: "e3", createdAt: new Date("2026-08-01T00:00:00.000Z"), agentId: null, amountCents: null, commissionCents: 100, commissionStatus: "PENDING", metadata: {} },
        { id: "e4", createdAt: new Date("2026-08-01T00:00:00.000Z"), agentId: "GONE", amountCents: null, commissionCents: 100, commissionStatus: "PENDING", metadata: {} },
      ],
      loansById,
      agentNameById,
    )
    // Distinct labels: "no agentId at all" and "an agentId that did not
    // resolve" are separate groups and must not share one subtotal heading.
    expect(rows.map((r) => r.agentName)).toEqual([UNASSIGNED_AGENT_NAME, UNKNOWN_AGENT_NAME])
  })

  it("returns an empty array for no events", () => {
    expect(buildStatementRows([], loansById, agentNameById)).toEqual([])
  })
})

function row(partial: Partial<StatementRow> & { id: string; agentId: string | null; agentName: string }): StatementRow {
  return {
    createdAt: "2026-08-01T00:00:00.000Z",
    agentResolved: partial.agentId !== null && partial.agentName !== UNKNOWN_AGENT_NAME && partial.agentName !== UNASSIGNED_AGENT_NAME,
    borrower: null,
    principalCents: null,
    commissionCents: 0,
    commissionStatus: "PENDING",
    ...partial,
  }
}

describe("groupStatementRows", () => {
  it("splits rows by agent and subtotals each one", () => {
    const groups = groupStatementRows([
      row({ id: "1", agentId: "A1", agentName: "Test Agent One", commissionCents: 3000, commissionStatus: "PENDING" }),
      row({ id: "2", agentId: "A2", agentName: "Amos Mockery", commissionCents: 5000, commissionStatus: "PAYABLE" }),
      row({ id: "3", agentId: "A1", agentName: "Test Agent One", commissionCents: 2000, commissionStatus: "PAYABLE" }),
    ])
    expect(groups.map((g) => [g.agentName, g.rows.length, g.totals.netOwedCents])).toEqual([
      ["Amos Mockery", 1, 5000],
      ["Test Agent One", 2, 5000],
    ])
  })

  it("orders by agent name, not by amount, so a block does not move between periods", () => {
    const groups = groupStatementRows([
      row({ id: "1", agentId: "A1", agentName: "Zanele", commissionCents: 90000, commissionStatus: "PENDING" }),
      row({ id: "2", agentId: "A2", agentName: "Amos", commissionCents: 100, commissionStatus: "PENDING" }),
    ])
    // Value-ordered would put Zanele first; this must not.
    expect(groups.map((g) => g.agentName)).toEqual(["Amos", "Zanele"])
  })

  it("per-agent subtotals sum to the grand total", () => {
    const rows = [
      row({ id: "1", agentId: "A1", agentName: "A", commissionCents: 3000, commissionStatus: "PENDING" }),
      row({ id: "2", agentId: "A2", agentName: "B", commissionCents: 5000, commissionStatus: "PAYABLE" }),
      row({ id: "3", agentId: null, agentName: UNASSIGNED_AGENT_NAME, commissionCents: 700, commissionStatus: "PENDING" }),
    ]
    const groups = groupStatementRows(rows)
    const summed = groups.reduce((acc, g) => acc + g.totals.netOwedCents, 0)
    // 3000 + 5000 + 700 — the orphan row must be inside the reconciliation, not
    // silently dropped, or the subtotals stop adding up to the footer.
    expect(summed).toBe(8700)
  })

  it("keeps agentless rows in one synthetic group rather than dropping them", () => {
    const groups = groupStatementRows([
      row({ id: "1", agentId: null, agentName: UNASSIGNED_AGENT_NAME, commissionCents: 100, commissionStatus: "PENDING" }),
      row({ id: "2", agentId: null, agentName: UNASSIGNED_AGENT_NAME, commissionCents: 200, commissionStatus: "PENDING" }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].agentId).toBe(UNKNOWN_AGENT_KEY)
    expect(groups[0].attributed).toBe(false)
    expect(groups[0].totals.netOwedCents).toBe(300)
  })

  it("excludes BLOCKED and NOT_ELIGIBLE money from a subtotal", () => {
    // Inherited from summariseCommission's allow-list; asserted here because a
    // subtotal is what someone gets paid.
    const groups = groupStatementRows([
      row({ id: "1", agentId: "A1", agentName: "A", commissionCents: 5000, commissionStatus: "PENDING" }),
      row({ id: "2", agentId: "A1", agentName: "A", commissionCents: 9999, commissionStatus: "BLOCKED" }),
      row({ id: "3", agentId: "A1", agentName: "A", commissionCents: 8888, commissionStatus: "NOT_ELIGIBLE" }),
    ])
    expect(groups[0].totals.netOwedCents).toBe(5000)
  })

  it("returns no groups for no rows", () => {
    expect(groupStatementRows([])).toEqual([])
  })
})

describe("centsToRands", () => {
  it("divides cents by 100", () => {
    expect(centsToRands(500000)).toBe(5000)
    expect(centsToRands(150)).toBe(1.5)
  })

  it("treats null as zero rather than throwing", () => {
    expect(centsToRands(null)).toBe(0)
  })

  it("treats zero as zero", () => {
    expect(centsToRands(0)).toBe(0)
  })
})

describe("statementScopeName", () => {
  it("names an all-agents export by its scope", () => {
    expect(statementScopeName(true, ["A", "B", "C"])).toBe("all agents")
  })

  it("names a single-agent export by that agent", () => {
    expect(statementScopeName(false, ["Test Agent One"])).toBe("Test Agent One")
  })

  it("names a multi-agent export by its count", () => {
    expect(statementScopeName(false, ["A", "B", "C"])).toBe("3 agents")
  })

  it("prefers the all-agents label even when the roster happens to hold one agent", () => {
    // "all agents" is a statement about SCOPE, not about how many rows the
    // roster happened to contain on the day — the distinction survives hiring.
    expect(statementScopeName(true, ["Only Agent"])).toBe("all agents")
  })
})

describe("statementFilename", () => {
  it("builds a stable, sanitised filename", () => {
    expect(statementFilename("Nhlanhla M.", "2026-08-01 to 2026-08-31")).toBe(
      "lms-statement-Nhlanhla-M-2026-08-01_2026-08-31.xlsx",
    )
  })

  it("strips characters that are unsafe in a Content-Disposition filename", () => {
    expect(statementFilename('Agent "Fast" & Co/Ltd', "2026-08-01 to 2026-08-31")).toBe(
      "lms-statement-Agent-Fast-Co-Ltd-2026-08-01_2026-08-31.xlsx",
    )
  })

  it("falls back to a generic label when the scope name sanitises to nothing", () => {
    expect(statementFilename("***", "2026-08-01 to 2026-08-31")).toBe(
      "lms-statement-agent-2026-08-01_2026-08-31.xlsx",
    )
  })

  it("names a multi-agent workbook by its scope, through the same sanitiser", () => {
    expect(statementFilename(statementScopeName(true, []), "2026-08-01 to 2026-08-31")).toBe(
      "lms-statement-all-agents-2026-08-01_2026-08-31.xlsx",
    )
    expect(statementFilename(statementScopeName(false, ["A", "B", "C"]), "2026-08-01 to 2026-08-31")).toBe(
      "lms-statement-3-agents-2026-08-01_2026-08-31.xlsx",
    )
  })
})

describe("isMultiAgentStatement", () => {
  const known = (id: string, name: string) => groupStatementRows([row({ id: `r-${id}`, agentId: id, agentName: name })])[0]
  const orphan = groupStatementRows([row({ id: "r-x", agentId: "gone", agentName: UNKNOWN_AGENT_NAME })])[0]

  it("uses the compact shape for exactly one requested, resolvable agent", () => {
    expect(isMultiAgentStatement(1, [known("A1", "Test Agent One")])).toBe(false)
  })

  it("attributes when more than one agent was REQUESTED, even if only one has rows", () => {
    // The divergence this function exists to kill: the preview keyed off the
    // groups (1) and the export keyed off the roster (2), so the same query
    // rendered two different shapes.
    expect(isMultiAgentStatement(2, [known("A1", "Test Agent One")])).toBe(true)
  })

  it("attributes when the rows span more than one agent", () => {
    expect(isMultiAgentStatement(1, [known("A1", "Test Agent One"), known("A2", "Amos")])).toBe(true)
  })

  it("attributes when the only group is not a resolvable payee", () => {
    // Otherwise an orphan's money renders under the compact shape and reads as
    // though it belongs to the agent named in the picker.
    expect(isMultiAgentStatement(1, [orphan])).toBe(true)
  })

  it("uses the compact shape when one agent was requested and has no rows", () => {
    expect(isMultiAgentStatement(1, [])).toBe(false)
  })
})
