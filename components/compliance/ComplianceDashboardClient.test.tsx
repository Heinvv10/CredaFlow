import { describe, it, expect } from "vitest"
import { ComplianceDashboardClient, NcrCard } from "./ComplianceDashboardClient"
import type { ComplianceHealth, ComplianceGroup } from "@/lib/compliance/record-types"

// The component uses no hooks — the quarter/group filtering is server-driven
// through links — so it is a plain function returning an element tree. Walking
// that tree needs no renderer and no DOM, the same pattern as
// components/agent-hub/StatementsTab.test.tsx.
//
// LIMITATION: the walker descends `props.children` but never INVOKES a child
// function component, so `render()` cannot see anything NcrCard,
// Section129ReconcileAction or Section129RecoveryAction emit. NcrCard is
// therefore exercised directly through `renderNcr` below. Do not add a
// `render()` assertion about NCR card text — it would pass or fail vacuously.

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  // Join with "" so adjacent text nodes concatenate the way the DOM renders
  // them: `{count} open exception` must read "1 open exception", not "1  open
  // exception".
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

const HEALTH: ComplianceHealth = {
  score: 100,
  complete: 2,
  total: 2,
  overdue: 0,
  openWithoutDueDate: 0,
  openExceptions: 0,
}

const GROUP_COUNTS: Record<ComplianceGroup, number> = {
  OBLIGATION: 2,
  EXCEPTION: 0,
  REGISTER: 153,
  LEGACY: 0,
}

function renderNcr(ncr: Parameters<typeof NcrCard>[0]["ncr"]) {
  return textOf(NcrCard({ ncr }))
}

function render(overrides: Partial<Parameters<typeof ComplianceDashboardClient>[0]> = {}) {
  const tree = ComplianceDashboardClient({
    records: [],
    health: HEALTH,
    totalCount: 155,
    groupCounts: GROUP_COUNTS,
    activeGroup: null,
    activeType: null,
    overLimit: false,
    rowCap: 200,
    bureauOverrideCount: 30,
    canReconcileSection129: true,
    ncrReturn: {
      ncrNumber: "NCRCP99999",
      quarter: "2026-Q2",
      quarterLabel: "Q2 2026",
      status: null,
      completedAt: null,
      dueDate: null,
    },
    ...overrides,
  })
  return textOf(tree)
}

describe("NCR quarterly return card", () => {
  it("says NOT PREPARED when no return exists, never SUBMITTED", () => {
    // A card with two branches would treat "no PENDING row" as proof of
    // submission. Where nothing has ever created an NCR_QUARTERLY_RETURN
    // record, that asserts a filed statutory return backed by nothing.
    const out = renderNcr({
      ncrNumber: "NCRCP99999",
      quarter: "2026-Q2", quarterLabel: "Q2 2026",
      status: null, completedAt: null, dueDate: null,
    })
    expect(out).toContain("NOT PREPARED")
    expect(out).toContain("No return on record for Q2 2026")
    expect(out).not.toContain("SUBMITTED")
  })

  it("says SUBMITTED only when a submitted record exists, with the filing date", () => {
    const out = renderNcr({
      ncrNumber: "NCRCP99999",
      quarter: "2026-Q2", quarterLabel: "Q2 2026",
      status: "SUBMITTED", completedAt: new Date("2026-07-05T08:00:00Z"), dueDate: null,
    })
    expect(out).toContain("SUBMITTED")
    expect(out).toContain("Q2 2026")
    expect(out).toContain("05 Jul 2026")
    expect(out).not.toContain("NOT PREPARED")
  })

  it("shows the pending state with its due date", () => {
    const out = renderNcr({
      ncrNumber: "NCRCP99999",
      quarter: "2026-Q2", quarterLabel: "Q2 2026",
      status: "PENDING", completedAt: null, dueDate: new Date("2026-07-31T00:00:00Z"),
    })
    expect(out).toContain("PENDING")
    expect(out).toContain("31 Jul 2026")
    expect(out).toContain("Prepare return")
    expect(out).not.toContain("NOT PREPARED")
  })

  it("names the quarter the return is due for rather than an unqualified badge", () => {
    const out = renderNcr({
      ncrNumber: "NCRCP99999",
      quarter: "2025-Q4", quarterLabel: "Q4 2025",
      status: null, completedAt: null, dueDate: null,
    })
    expect(out).toContain("Q4 2025")
  })
})

describe("compliance health card", () => {
  it("states the obligation denominator, not just a percentage", () => {
    const out = render({ health: { ...HEALTH, score: 50, complete: 1, total: 2 } })
    expect(out).toContain("1 of 2 statutory obligations complete")
  })

  it("distinguishes an empty obligation register from full compliance", () => {
    // 100% with nothing recorded is not evidence of compliance.
    const out = render({ health: { ...HEALTH, score: 100, complete: 0, total: 0 } })
    expect(out).toContain("No obligations")
    expect(out).toContain("No statutory filings recorded yet")
    // Absence here is not absence of evidence: consent, affordability and
    // pre-agreement records live on the client and application, not in this table.
    expect(out).toContain("client and application records")
    expect(out).not.toContain("Good Standing")
  })

  it("reads Good Standing only at or above 80%", () => {
    expect(render({ health: { ...HEALTH, score: 80, complete: 4, total: 5 } })).toContain("Good Standing")
    expect(render({ health: { ...HEALTH, score: 79, complete: 79, total: 100 } })).toContain("Needs Attention")
    expect(render({ health: { ...HEALTH, score: 59, complete: 59, total: 100 } })).toContain("At Risk")
  })
})

describe("overdue card", () => {
  it("claims all items on track only when nothing is open", () => {
    const out = render({ health: { ...HEALTH, overdue: 0, openWithoutDueDate: 0 } })
    expect(out).toContain("All items on track")
  })

  it("does not claim all on track while obligations sit open with no due date", () => {
    // Such a record can never age into overdue, so a bare zero was an
    // unearned assurance.
    const out = render({ health: { ...HEALTH, overdue: 0, openWithoutDueDate: 3 } })
    expect(out).not.toContain("All items on track")
    expect(out).toContain("3 open with no due date")
  })

  it("surfaces open exceptions separately from the score", () => {
    const out = render({ health: { ...HEALTH, openExceptions: 2 } })
    expect(out).toContain("2 open exceptions")
  })

  it("singularises one exception", () => {
    expect(render({ health: { ...HEALTH, openExceptions: 1 } })).toContain("1 open exception")
  })
})

describe("record table", () => {
  it("labels every type rather than printing the raw enum", () => {
    const out = render({ records: [
      { id: "1", type: "KYC_EXCEPTION", status: "COMPLETED", referenceId: "abc12345678", dueDate: null, completedAt: new Date("2026-08-15T00:00:00Z"), createdAt: new Date("2026-08-15T00:00:00Z"), data: {} },
      { id: "2", type: "CREDIT_BUREAU_CHECK", status: "PENDING", referenceId: null, dueDate: null, completedAt: null, createdAt: new Date("2026-08-14T00:00:00Z"), data: {} },
    ] })
    expect(out).toContain("KYC Exception")
    expect(out).toContain("Credit Bureau Check")
    expect(out).not.toContain("KYC_EXCEPTION")
    expect(out).not.toContain("CREDIT_BUREAU_CHECK")
  })

  it("shows every group tab with a true total count", () => {
    const out = render()
    expect(out).toContain("Obligations")
    expect(out).toContain("Exceptions")
    expect(out).toContain("Registers")
    expect(out).toContain("155")
    expect(out).toContain("153")
  })

  it("says so when the row cap truncates the table", () => {
    expect(render({ overLimit: true, rowCap: 200 }))
      .toContain("Showing the 200 most recent")
  })

  it("does not claim truncation when the set fits", () => {
    expect(render({ overLimit: false })).not.toContain("most recent")
  })

  it("shows an empty state rather than a bare table", () => {
    expect(render({ records: [] })).toContain("No compliance records match this filter")
  })

  it("marks the bureau override count as an all-time figure", () => {
    expect(render({ bureauOverrideCount: 30 })).toContain("All time")
  })

  it("hides the bureau override card from roles below LOAN_ADMIN", () => {
    const out = render({ bureauOverrideCount: null })
    expect(out).not.toContain("Bureau s.81 overrides")
    expect(out).not.toContain("Breach Log")
  })
})

describe("legacy type filter", () => {
  it("says where the evidence lives when filtered to a type nothing writes", () => {
    const out = render({ activeType: "POPIA_CONSENT" })
    expect(out).toContain("Filtered to POPIA Consent")
    expect(out).toContain("Consent is recorded in ConsentRecord on the client")
  })

  it("shows no evidence hint for a real obligation type", () => {
    const out = render({ activeType: "FAIS_DISCLOSURE" })
    expect(out).toContain("Filtered to FAIS Disclosure")
    expect(out).not.toContain("is recorded in")
  })
})
