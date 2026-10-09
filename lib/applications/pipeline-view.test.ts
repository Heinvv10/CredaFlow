import { describe, expect, it } from "vitest"
import { DISBURSEMENT_PRECONDITION_ORDER } from "@/lib/disbursement/preconditions"
import {
  AGE_BUCKETS,
  ANY,
  applyFilters,
  ageInDays,
  CLOSED_STATUSES,
  DEFAULT_COLUMN_SORT,
  EMPTY_FILTERS,
  filtersAreActive,
  latestRefusalByApplication,
  PAYOUT_BLOCK_LABELS,
  payoutBlock,
  PIPELINE_COLUMNS,
  presentBlockReasons,
  readyCount,
  sortApplications,
  sortOptionsForColumn,
  optionsIncludingValue,
  statusEnteredAt,
  statusSelectValue,
  toColumnSortKey,
  toSortKey,
  UNASSIGNED,
  type PipelineApplication,
} from "./pipeline-view"

const NOW = new Date("2026-08-19T10:00:00.000Z")

function app(overrides: Partial<PipelineApplication> = {}): PipelineApplication {
  return {
    id: "app-1",
    reference: "APP-TEST-0002",
    status: "APPROVED",
    appliedAmount: 200_000,
    createdAt: new Date("2026-08-10T08:00:00.000Z"),
    submittedAt: new Date("2026-08-11T08:00:00.000Z"),
    approvedAt: new Date("2026-08-17T08:00:00.000Z"),
    disbursedAt: null,
    updatedAt: new Date("2026-08-17T08:00:00.000Z"),
    client: { firstName: "SIPHO", lastName: "TESTPERSON" },
    product: { name: "30-Day Loan", productType: "SHORT_TERM" },
    branch: { name: "Belfast" },
    assignedTo: { name: "Officer One" },
    payoutRefusal: null,
    readiness: null,
    ...overrides,
  }
}

describe("payout block", () => {
  // The production case this exists for: application clxtestpayoutrefused00001
  // was refused at payout FIVE times across 2026-08-17 and 18 — four of them by
  // Officer One — and the board drew a clean Approved card the whole time.
  const refused = app({
    payoutRefusal: {
      reason: "verified_banking",
      refusedAt: new Date("2026-08-18T18:17:35.246Z"),
      attempts: 5,
    },
    updatedAt: new Date("2026-08-17T08:00:00.000Z"),
  })

  it("names the reason and the number of attempts", () => {
    expect(payoutBlock(refused)).toEqual({
      reason: "verified_banking",
      label: "Banking not verified",
      attempts: 5,
      refusedAt: new Date("2026-08-18T18:17:35.246Z"),
    })
  })

  it("clears once the application changes after the refusal", () => {
    // The evidence it refused on may have been corrected. Staleness closes at
    // the next write rather than at a timeout.
    expect(payoutBlock({
      ...refused,
      updatedAt: new Date("2026-08-18T18:23:37.801Z"),
    })).toBeNull()
  })

  it("holds when the write and the refusal share a timestamp", () => {
    // Strictly-after, not at-or-after: a write in the same millisecond is not
    // evidence that anything was fixed.
    expect(payoutBlock({
      ...refused,
      updatedAt: new Date("2026-08-18T18:17:35.246Z"),
    })?.reason).toBe("verified_banking")
  })

  it("reports nothing for an application nobody has tried to pay out", () => {
    // A DIFFERENT state from "clear", and the caller must render it as such.
    expect(payoutBlock(app())).toBeNull()
  })

  it("shows an unmapped reason rather than swallowing it", () => {
    expect(payoutBlock(app({
      payoutRefusal: {
        reason: "some_future_precondition",
        refusedAt: new Date("2026-08-18T18:00:00.000Z"),
        attempts: 1,
      },
    }))?.label).toBe("some_future_precondition")
  })

  it("labels every precondition the disburse route can refuse on", () => {
    // Driven out of the route's own vocabulary. A precondition added there with
    // no label here renders as raw snake_case on a staff screen.
    for (const precondition of DISBURSEMENT_PRECONDITION_ORDER) {
      expect(PAYOUT_BLOCK_LABELS[precondition]).toBeTruthy()
    }
    expect(Object.keys(PAYOUT_BLOCK_LABELS).sort())
      .toEqual([...DISBURSEMENT_PRECONDITION_ORDER].sort())
  })
})

describe("time in the current state", () => {
  it("measures Approved from approval, not from application", () => {
    // Sorting Approved by createdAt answers "applied for first". The lane's
    // question is "waiting to be paid out longest".
    expect(statusEnteredAt(app())).toEqual(new Date("2026-08-17T08:00:00.000Z"))
    expect(ageInDays(app(), NOW)).toBe(2)
  })

  it("measures Submitted from submission", () => {
    expect(statusEnteredAt(app({ status: "SUBMITTED" })))
      .toEqual(new Date("2026-08-11T08:00:00.000Z"))
  })

  it("measures Draft from creation — a draft was never submitted", () => {
    expect(statusEnteredAt(app({ status: "DRAFT", submittedAt: null })))
      .toEqual(new Date("2026-08-10T08:00:00.000Z"))
  })

  it("falls back through the chain when a stamp is missing", () => {
    expect(statusEnteredAt(app({ status: "DISBURSED", disbursedAt: null })))
      .toEqual(new Date("2026-08-17T08:00:00.000Z"))
  })
})

describe("ordering", () => {
  const older = app({ id: "older", approvedAt: new Date("2026-08-12T08:00:00.000Z"), appliedAmount: 500_000 })
  const newer = app({ id: "newer", approvedAt: new Date("2026-08-18T08:00:00.000Z"), appliedAmount: 100_000 })

  it("defaults the working lanes to oldest first", () => {
    // Newest-first was the single order this board used everywhere, and it
    // buries the application that has waited longest under everything that
    // arrived since.
    for (const lane of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"]) {
      expect(DEFAULT_COLUMN_SORT[lane]).toBe("oldest")
    }
  })

  it("defaults Disbursed to newest first — it is a record, not a queue", () => {
    expect(DEFAULT_COLUMN_SORT.DISBURSED).toBe("newest")
  })

  it("orders oldest and newest by time in state", () => {
    expect(sortApplications([newer, older], "oldest").map((a) => a.id))
      .toEqual(["older", "newer"])
    expect(sortApplications([older, newer], "newest").map((a) => a.id))
      .toEqual(["newer", "older"])
  })

  it("orders by amount in both directions", () => {
    expect(sortApplications([newer, older], "amount_desc").map((a) => a.id))
      .toEqual(["older", "newer"])
    expect(sortApplications([older, newer], "amount_asc").map((a) => a.id))
      .toEqual(["newer", "older"])
  })

  it("does not mutate the array it was given", () => {
    // It sorts React state in the board; sorting in place skips the re-render.
    const input = [newer, older]
    sortApplications(input, "oldest")
    expect(input.map((a) => a.id)).toEqual(["newer", "older"])
  })
})

describe("ready-first ordering", () => {
  const ready = app({
    id: "ready",
    approvedAt: new Date("2026-08-15T08:00:00.000Z"),
    readiness: { stage: "READY", blockers: [] },
  })
  const blockedOld = app({
    id: "blocked-old",
    approvedAt: new Date("2026-08-12T08:00:00.000Z"),
    readiness: { stage: "MISSING", blockers: ["Payslip missing"] },
  })
  const blockedNew = app({
    id: "blocked-new",
    approvedAt: new Date("2026-08-18T08:00:00.000Z"),
    readiness: { stage: "MISSING", blockers: ["Payslip missing"] },
  })
  const noChipOld = app({
    id: "no-chip-old",
    approvedAt: new Date("2026-08-10T08:00:00.000Z"),
    readiness: null,
  })
  const noChipNew = app({
    id: "no-chip-new",
    approvedAt: new Date("2026-08-19T08:00:00.000Z"),
    readiness: null,
  })

  it("puts READY cards above everything else", () => {
    expect(sortApplications([blockedOld, ready, blockedNew], "ready_first").map((a) => a.id))
      .toEqual(["ready", "blocked-old", "blocked-new"])
  })

  it("breaks ties within a group by oldest first", () => {
    expect(sortApplications([blockedNew, blockedOld], "ready_first").map((a) => a.id))
      .toEqual(["blocked-old", "blocked-new"])
  })

  it("treats no-readiness (null) the same tier as blocked, not above READY", () => {
    // A card with no chip at all (Draft/Disbursed shape) must not read as
    // "ready" just because it has no blocker to name.
    const result = sortApplications([noChipNew, ready, noChipOld], "ready_first").map((a) => a.id)
    expect(result[0]).toBe("ready")
    expect(result.slice(1)).toEqual(["no-chip-old", "no-chip-new"])
  })

  it("interleaves null and MISSING by age within the lower tier", () => {
    expect(sortApplications([blockedNew, noChipOld, blockedOld, noChipNew], "ready_first")
      .map((a) => a.id))
      .toEqual(["no-chip-old", "blocked-old", "blocked-new", "no-chip-new"])
  })
})

describe("sort options per column", () => {
  it("offers ready-first only where readiness is computed", () => {
    for (const status of ["SUBMITTED", "UNDER_REVIEW", "APPROVED"]) {
      expect(sortOptionsForColumn(status)).toContain("ready_first")
    }
  })

  it("does not offer ready-first for columns with no readiness chip", () => {
    for (const status of ["DRAFT", "DISBURSED"]) {
      expect(sortOptionsForColumn(status)).not.toContain("ready_first")
    }
  })
})

describe("column-aware sort key from a URL", () => {
  it("keeps ready_first for a column that supports it", () => {
    expect(toColumnSortKey("ready_first", "APPROVED", "oldest")).toBe("ready_first")
  })

  it("falls back instead of round-tripping ready_first into a column without readiness", () => {
    // A hand-edited `?sort_DRAFT=ready_first` must not reach the <select> as a
    // selected value with no matching option — that is the option[0] trap.
    expect(toColumnSortKey("ready_first", "DRAFT", "oldest")).toBe("oldest")
    expect(toColumnSortKey("ready_first", "DISBURSED", "newest")).toBe("newest")
  })

  it("still falls back for a garbage key regardless of column", () => {
    expect(toColumnSortKey("garbage", "APPROVED", "oldest")).toBe("oldest")
  })
})

describe("readiness", () => {
  const ready = app({ id: "ready", readiness: { stage: "READY", blockers: [] } })
  const missing = app({
    id: "missing",
    readiness: { stage: "MISSING", blockers: ["Payslip missing"] },
  })
  const unassessed = app({ id: "unassessed", status: "DRAFT", readiness: null })
  const pool = [ready, missing, unassessed]

  it("counts only the applications with a READY chip", () => {
    expect(readyCount(pool)).toBe(1)
    expect(readyCount([unassessed])).toBe(0)
  })

  it("ready-only keeps READY and drops both MISSING and un-chipped", () => {
    // A DRAFT has no gate to be ready for. Letting it through would put the
    // lane with nothing to do at the top of a queue of work that IS ready.
    expect(
      applyFilters(pool, { ...EMPTY_FILTERS, readyOnly: true }, NOW).map((a) => a.id),
    ).toEqual(["ready"])
  })

  it("counts as an active filter, so the Clear affordance appears", () => {
    expect(filtersAreActive({ ...EMPTY_FILTERS, readyOnly: true })).toBe(true)
  })
})

describe("filters", () => {
  const belfast = app({ id: "belfast", branch: { name: "Belfast" }, appliedAmount: 200_000 })
  const witbank = app({
    id: "witbank",
    branch: { name: "Witbank" },
    assignedTo: { name: "Officer Two" },
    appliedAmount: 1_500_000,
    product: { name: "Payroll Loan", productType: "PAYROLL" },
    approvedAt: new Date("2026-06-01T08:00:00.000Z"),
  })
  const unbranched = app({ id: "unbranched", branch: null, assignedTo: null })
  const all = [belfast, witbank, unbranched]

  const ids = (filters: Partial<typeof EMPTY_FILTERS>) =>
    applyFilters(all, { ...EMPTY_FILTERS, ...filters }, NOW).map((a) => a.id)

  it("returns everything when nothing is set", () => {
    expect(ids({})).toEqual(["belfast", "witbank", "unbranched"])
    expect(filtersAreActive(EMPTY_FILTERS)).toBe(false)
  })

  it("filters by branch, and by having no branch at all", () => {
    expect(ids({ branch: "Witbank" })).toEqual(["witbank"])
    expect(ids({ branch: UNASSIGNED })).toEqual(["unbranched"])
  })

  it("filters by assignee, and by unassigned", () => {
    expect(ids({ assignee: "Officer Two" })).toEqual(["witbank"])
    expect(ids({ assignee: UNASSIGNED })).toEqual(["unbranched"])
  })

  it("filters by amount band on half-open ranges", () => {
    // R2 000 exactly belongs to the 2k–10k band, not to "under R2 000" — an
    // inclusive upper bound would put it in both.
    expect(ids({ amountBand: "lt2k" })).toEqual([])
    expect(ids({ amountBand: "2k_10k" })).toEqual(["belfast", "unbranched"])
    expect(ids({ amountBand: "gt10k" })).toEqual(["witbank"])
  })

  it("filters by age in the CURRENT state", () => {
    expect(ids({ ageBucket: "30d" })).toEqual(["witbank"])
  })

  it("filters by status", () => {
    expect(ids({ statuses: ["CANCELLED"] })).toEqual([])
    expect(ids({ statuses: ["APPROVED"] })).toHaveLength(3)
  })

  it("searches name, reference, product and the rand amount on the card", () => {
    expect(ids({ search: "payroll" })).toEqual(["witbank"])
    expect(ids({ search: "TESTPERSON" })).toEqual(["belfast", "witbank", "unbranched"])
    // 1 500 000 cents renders as R15 000 — staff search what they can see.
    expect(ids({ search: "15000" })).toEqual(["witbank"])
  })

  it("filters to blocked payouts, and to one reason", () => {
    const blocked = app({
      id: "blocked",
      payoutRefusal: {
        reason: "verified_banking",
        refusedAt: new Date("2026-08-18T18:17:35.246Z"),
        attempts: 5,
      },
    })
    const otherReason = app({
      id: "kyc",
      payoutRefusal: {
        reason: "composite_kyc",
        refusedAt: new Date("2026-08-18T18:00:00.000Z"),
        attempts: 1,
      },
    })
    const pool = [belfast, blocked, otherReason]
    const pick = (blockedFilter: string) =>
      applyFilters(pool, { ...EMPTY_FILTERS, blocked: blockedFilter }, NOW).map((a) => a.id)

    expect(pick(ANY)).toEqual(["belfast", "blocked", "kyc"])
    expect(pick("blocked")).toEqual(["blocked", "kyc"])
    expect(pick("verified_banking")).toEqual(["blocked"])
  })

  it("lists only the block reasons actually present", () => {
    // Offering all eight preconditions would be seven dead options.
    const blocked = app({
      id: "blocked",
      payoutRefusal: {
        reason: "verified_banking",
        refusedAt: new Date("2026-08-18T18:17:35.246Z"),
        attempts: 5,
      },
    })
    expect(presentBlockReasons([belfast, blocked, { ...blocked, id: "b2" }]))
      .toEqual([{ reason: "verified_banking", label: "Banking not verified", count: 2 }])
    expect(presentBlockReasons([belfast])).toEqual([])
  })
})

describe("board shape", () => {
  it("renders five lanes and keeps the terminal states out of them", () => {
    expect(PIPELINE_COLUMNS.map((c) => c.key))
      .toEqual(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "DISBURSED"])
    for (const status of CLOSED_STATUSES) {
      expect(PIPELINE_COLUMNS.map((c) => c.key as string)).not.toContain(status)
    }
  })

  it("gives every closed status a default order for the table", () => {
    // They have no lane, but the table still sorts them.
    for (const status of CLOSED_STATUSES) {
      expect(DEFAULT_COLUMN_SORT[status]).toBeTruthy()
    }
  })

  it("offers age buckets that start at 'any'", () => {
    expect(AGE_BUCKETS[0]).toMatchObject({ key: "any", minDays: 0 })
  })
})

describe("collapsing refusal audit rows", () => {
  const row = (entityId: string, iso: string, reason?: string) => ({
    entityId,
    createdAt: new Date(iso),
    newValue: reason === undefined
      ? { refused: true, httpStatus: 422 }
      : { reason, refused: true, httpStatus: 422 },
  })

  it("takes the latest reason and counts every attempt", () => {
    // Production shape: clxtestpayoutrefused00001, five refusals across two
    // days. A board showing only the newest reason reads the fifth attempt the
    // same as the first, which is the signal staff need.
    const rows = [
      row("app-1", "2026-08-18T18:17:35.246Z", "verified_banking"),
      row("app-1", "2026-08-18T09:06:44.484Z", "verified_banking"),
      row("app-1", "2026-08-18T09:03:10.767Z", "verified_banking"),
      row("app-1", "2026-08-17T13:25:18.960Z", "composite_kyc"),
      row("app-2", "2026-08-18T14:14:57.632Z", "verified_banking"),
    ]
    const collapsed = latestRefusalByApplication(rows)
    expect(collapsed.get("app-1")).toEqual({
      reason: "verified_banking",
      refusedAt: new Date("2026-08-18T18:17:35.246Z"),
      attempts: 4,
    })
    expect(collapsed.get("app-2")?.attempts).toBe(1)
  })

  it("does not invent a reason for a row that carries none", () => {
    expect(latestRefusalByApplication([row("app-1", "2026-08-18T18:00:00.000Z")])
      .get("app-1")?.reason).toBe("unknown")
  })

  it("skips a row with no application on it", () => {
    // `AuditLog.entityId` is nullable, so a subject-less row is possible and
    // belongs to no application.
    expect(latestRefusalByApplication([
      { entityId: null, createdAt: new Date("2026-08-18T18:00:00.000Z"), newValue: {} },
      row("app-1", "2026-08-18T17:00:00.000Z", "verified_banking"),
    ]).size).toBe(1)
  })

  it("is empty when nothing has been refused", () => {
    expect(latestRefusalByApplication([]).size).toBe(0)
  })
})

describe("controls cannot claim a state they are not in", () => {
  // A <select> whose value matches no option displays the FIRST one, silently.
  // This class has reached production twice in this codebase.
  const options = [
    { value: "all", label: "All products" },
    { value: "30-Day Loan", label: "30-Day Loan" },
  ]

  it("leaves a known value's options alone", () => {
    expect(optionsIncludingValue("30-Day Loan", options)).toEqual(options)
  })

  it("names a value that is no longer in the data", () => {
    // A bookmarked link filtered to a product that has since gone: without
    // this the control reads "All products" over an empty board.
    expect(optionsIncludingValue("Retired Product", options)).toEqual([
      { value: "Retired Product", label: "Retired Product (not in view)" },
      ...options,
    ])
  })

  it("gives the two-status closed filter a value of its own", () => {
    // Collapsing this to `all` made the status control read "All statuses"
    // immediately after the one link that sets it.
    expect(statusSelectValue(["DECLINED", "CANCELLED"])).toBe("DECLINED,CANCELLED")
    expect(statusSelectValue(["APPROVED"])).toBe("APPROVED")
    expect(statusSelectValue([])).toBe(ANY)
  })
})

describe("sort keys from a URL", () => {
  it("keeps a real key", () => {
    expect(toSortKey("amount_desc", "newest")).toBe("amount_desc")
  })

  it("falls back for a hand-edited or stale one", () => {
    // `?sort_APPROVED=garbage` reached the comparator, which ordered nothing,
    // while the lane's <select> displayed its first option instead.
    expect(toSortKey("garbage", "oldest")).toBe("oldest")
    expect(toSortKey(null, "oldest")).toBe("oldest")
    expect(toSortKey(undefined, "newest")).toBe("newest")
    expect(toSortKey("", "newest")).toBe("newest")
  })

  it("leaves the list untouched when the comparator meets a bad key", () => {
    // Second line of defence. A switch with no default returns undefined for
    // every pair, which sorts nothing while looking like it sorted.
    const a = app({ id: "a", approvedAt: new Date("2026-08-12T08:00:00.000Z") })
    const b = app({ id: "b", approvedAt: new Date("2026-08-18T08:00:00.000Z") })
    expect(sortApplications([b, a], "garbage" as never).map((x) => x.id))
      .toEqual(["b", "a"])
  })
})
