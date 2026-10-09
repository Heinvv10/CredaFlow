import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ApplicationKanban } from "./ApplicationKanban"
import { DEFAULT_COLUMN_SORT, type PipelineApplication } from "@/lib/applications/pipeline-view"
import { READY_CAVEAT } from "@/lib/applications/readiness-view"

const NOW = new Date("2026-08-19T10:00:00.000Z")

function app(overrides: Partial<PipelineApplication> = {}): PipelineApplication {
  return {
    id: "app-1",
    reference: "APP-TEST-0001",
    status: "APPROVED",
    appliedAmount: 200_000,
    createdAt: new Date("2026-08-10T08:00:00.000Z"),
    submittedAt: new Date("2026-08-11T08:00:00.000Z"),
    approvedAt: new Date("2026-08-17T08:00:00.000Z"),
    disbursedAt: null,
    updatedAt: new Date("2026-08-17T08:00:00.000Z"),
    client: { firstName: "VUSI", lastName: "MOCKTEST" },
    product: { name: "30-Day Loan", productType: "SHORT_TERM" },
    branch: { name: "Belfast" },
    assignedTo: { name: "Officer One" },
    payoutRefusal: null,
    readiness: null,
    ...overrides,
  }
}

function render(applications: PipelineApplication[]) {
  return renderToStaticMarkup(
    <ApplicationKanban
      applications={applications}
      columnSort={DEFAULT_COLUMN_SORT}
      onColumnSortChange={() => {}}
      isFiltered={false}
      now={NOW}
    />,
  )
}

describe("ApplicationKanban readiness chip", () => {
  it("says what an application with no outstanding blocker is ready FOR", () => {
    const html = render([app({ readiness: { stage: "READY", blockers: [] } })])
    expect(html).toContain("Ready to disburse")
  })

  it("uses the wording of the lane the card is in", () => {
    const html = render([
      app({
        id: "submitted",
        status: "SUBMITTED",
        readiness: { stage: "READY", blockers: [] },
      }),
      app({
        id: "under-review",
        status: "UNDER_REVIEW",
        readiness: { stage: "READY", blockers: [] },
      }),
    ])
    expect(html).toContain("Ready for review")
    expect(html).toContain("Ready to approve")
  })

  it("carries the payout caveat on the green chip, where the operator can see it", () => {
    // The four byte-level checks are re-run at payout, so READY is not a
    // guarantee. That used to be said only in a source comment.
    const html = render([app({ readiness: { stage: "READY", blockers: [] } })])
    expect(html).toContain(READY_CAVEAT)
  })

  it("names the first two blockers and counts the rest", () => {
    const html = render([
      app({
        readiness: {
          stage: "MISSING",
          blockers: ["Payslip missing", "ID Copy missing", "Banking not verified"],
        },
      }),
    ])
    expect(html).toContain("3 missing: Payslip missing, ID Copy missing +1")
  })

  it("puts the FULL blocker list on the title, so the +N is recoverable", () => {
    const html = render([
      app({
        readiness: {
          stage: "MISSING",
          blockers: ["Payslip missing", "ID Copy missing", "Banking not verified"],
        },
      }),
    ])
    expect(html).toContain(
      "Payslip missing, ID Copy missing, Banking not verified",
    )
  })

  it("draws no chip on a lane with no gate ahead of it", () => {
    const html = render([app({ status: "DRAFT", readiness: null })])
    // Not a bare "not.toContain('Ready')": every lane's sort <select> now
    // offers a "Ready first" option regardless of what is in it, so that
    // string alone appears on every render. The chip-specific strings are the
    // ones that would prove a false-positive chip on a Draft card.
    expect(html).not.toContain("Ready to")
    expect(html).not.toContain("Ready for")
    expect(html).not.toContain("missing:")
  })
})

describe("ApplicationKanban column header", () => {
  it("counts how many of a lane's cards are ready", () => {
    const html = render([
      app({ id: "a", readiness: { stage: "READY", blockers: [] } }),
      app({ id: "b", readiness: { stage: "READY", blockers: [] } }),
      app({ id: "c", readiness: { stage: "MISSING", blockers: ["Payslip missing"] } }),
    ])
    expect(html).toContain("3 · 2 ready")
  })

  it("reports zero ready when every card in the lane is blocked", () => {
    const html = render([
      app({ readiness: { stage: "MISSING", blockers: ["Payslip missing"] } }),
    ])
    expect(html).toContain("1 · 0 ready")
  })

  it("shows a bare count on a lane whose cards carry no chip", () => {
    // "0 ready" over Draft would read as a queue standing still, rather than
    // one with nothing to be ready for.
    const html = render([app({ status: "DRAFT", readiness: null })])
    expect(html).not.toContain("0 ready")
  })
})

describe("ApplicationKanban sort menu", () => {
  it("offers Ready first only on lanes readiness is computed for", () => {
    const html = render([app({ status: "SUBMITTED" }), app({ status: "DRAFT" })])
    // One <select> per lane; count rather than presence, so a regression that
    // drops the option from a lane that should have it isn't masked by the
    // one that correctly does.
    expect(html.match(/<option value="ready_first">/g)).toHaveLength(3)
  })

  it("does not offer Ready first on Draft or Disbursed", () => {
    const html = render([app({ status: "DRAFT" })])
    const draftSelect = html.match(/aria-label="Sort Draft"[\s\S]*?<\/select>/)?.[0] ?? ""
    const disbursedSelect = html.match(/aria-label="Sort Disbursed"[\s\S]*?<\/select>/)?.[0] ?? ""
    expect(draftSelect).not.toContain("ready_first")
    expect(disbursedSelect).not.toContain("ready_first")
  })
})
