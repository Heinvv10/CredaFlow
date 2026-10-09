import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The collectible book answers ONE question: what is still owed, for reporting.
 * It is not payment-allocation eligibility, not Section 129 eligibility, and
 * not who gets chased — those are behaviour, and widening them would change
 * what the system does to real accounts rather than what it reports.
 *
 * The two populations happen to overlap today (ACTIVE + DEFAULTED), which is
 * exactly why a well-meaning sweep of `["ACTIVE","DEFAULTED"]` literals could
 * swap COLLECTIBLE_STATUSES into a money path without anyone noticing. This
 * test pins the boundary.
 *
 * If you are here because this failed: decide which question the call site
 * answers. If it is reporting, add it to REPORTING below. If it is behaviour,
 * it must NOT use COLLECTIBLE_STATUSES.
 */

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

/**
 * Strip comments before checking. The behaviour files deliberately MENTION
 * COLLECTIBLE_STATUSES in a "do not use this here" comment, and a bare
 * substring check would read that warning as a violation of itself.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

// Paths that decide what the system DOES to a loan.
//
// `app/(dashboard)/collections/page.tsx` is here, not in REPORTING, and that
// distinction is the whole point: its queue, its S129-due count and its stage
// breakdown are WORK LISTS. Widening them to the book put PENDING_WRITE_OFF
// loans in front of officers where every action is refused. This test file
// classified that page wholesale as reporting and stayed green while it did —
// which is why the classification below is per-file and deliberate, not a
// convenience.
const BEHAVIOUR_PATHS = [
  "app/(dashboard)/collections/page.tsx",
  "app/api/payments/bulk-upload/route.ts",
  "app/api/payments/[id]/reconcile/route.ts",
  "app/api/portal/payment/webhook/route.ts",
  "lib/loan/apply-payment.ts",
  "lib/bank-sync/apply.ts",
  "lib/bank-sync/candidates.ts",
  "lib/collections/section129-eligibility.ts",
  "lib/collections/escalation.ts",
  "lib/automation/engine.ts",
  "app/(dashboard)/payments/bank-reconciliation/data.ts",
  "app/(dashboard)/loans/[id]/page.tsx",
]

// Paths that decide what the system REPORTS about a loan.
const REPORTING_PATHS = [
  "lib/reports/par.ts",
  "lib/compliance/ncr-return.ts",
  "app/(dashboard)/page.tsx",
  "app/(dashboard)/layout.tsx",
  "app/(dashboard)/reports/page.tsx",
  "app/(dashboard)/reports/board-pack/page.tsx",
  "app/api/reports/export/route.ts",
  "app/(dashboard)/reports/arrears-aging/page.tsx",
]

describe("the reporting / behaviour boundary", () => {
  // Importing the module is the invariant, not naming the constant — the
  // reporting surfaces reach it through COLLECTIBLE_STATUSES or through the
  // collectibleLoanWhere / collectibleParWhere helpers.
  const IMPORTS_BOOK = /from "@\/lib\/loan\/collectible-book"/

  it.each(BEHAVIOUR_PATHS)("%s does not use the reporting population", (path) => {
    const src = code(path)
    expect(src).not.toMatch(IMPORTS_BOOK)
    expect(src).not.toContain("COLLECTIBLE_STATUSES")
  })

  it.each(REPORTING_PATHS)("%s uses the shared population, not a literal", (path) => {
    const src = code(path)
    expect(src).toMatch(IMPORTS_BOOK)
    // A stray literal beside the shared constant is how the two drift apart.
    expect(src).not.toMatch(/status:\s*\{\s*in:\s*\["ACTIVE",\s*"DEFAULTED"\]\s*\}/)
  })

  // The DPD cron is neither purely reporting nor purely behaviour: it MAINTAINS
  // the columns reporting reads. So it must refresh the whole book — a status it
  // skips is a loan frozen in a fictional DPD band — while its state transitions
  // stay on the narrower population. An earlier version of this file pinned the
  // cron's read to ACTIVE+DEFAULTED, which entrenched exactly that staleness.
  describe("dpd-update maintains the book without transitioning it", () => {
    const src = () => code("app/api/cron/dpd-update/route.ts")

    it("reads the whole collectible book", () => {
      expect(src()).toMatch(IMPORTS_BOOK)
      expect(src()).toContain("collectibleLoanWhere(tenantId)")
    })

    it("promotes to DEFAULTED only from ACTIVE", () => {
      // Promoting a PENDING_WRITE_OFF loan would silently cancel a pending
      // write-off request; re-defaulting a RESTRUCTURED one would undo the
      // arrangement.
      expect(src()).toMatch(/newDpd >= 90 && loan\.status === "ACTIVE" && \{ status: "DEFAULTED" \}/)
    })

    it("keeps commission clawback on the statuses it already covered", () => {
      // Widening the read must not move money.
      expect(src()).toMatch(/newDpd >= 90 && \(loan\.status === "ACTIVE" \|\| loan\.status === "DEFAULTED"\)/)
    })
  })

  it("lets arrears-aging add WRITTEN_OFF, but only as an explicit addition", () => {
    // The one documented deviation: a collections drill-down that also shows
    // written-off accounts, each row status-labelled. It must still build on
    // the shared book rather than re-listing statuses, or it drifts again — it
    // previously omitted PENDING_WRITE_OFF and RESTRUCTURED while every other
    // reporting surface included them.
    const src = code("app/(dashboard)/reports/arrears-aging/page.tsx")
    expect(src).toContain('status: { in: [...COLLECTIBLE_STATUSES, "WRITTEN_OFF"] }')
  })

  it("keeps the collections work lists on the eligibility population", () => {
    // The S129-due header count must match what the bulk-send route will
    // actually accept (audit F-22), or the page advertises work the API
    // refuses.
    const page = code("app/(dashboard)/collections/page.tsx")
    const bulk = code("app/api/loans/section129/bulk/route.ts")
    expect(page).toContain("COLLECTIONS_ELIGIBLE_STATUSES")
    expect(bulk).toContain("COLLECTIONS_ELIGIBLE_STATUSES")
    expect(page).not.toContain("COLLECTIBLE_STATUSES")
  })

  it("keeps Section 129 eligibility separate from the book", () => {
    // S.129 is a legal precondition for enforcement, not a reporting view.
    const src = code("lib/collections/section129-eligibility.ts")
    expect(src).toContain('COLLECTIONS_ELIGIBLE_STATUSES = ["ACTIVE", "DEFAULTED"]')
  })
})
