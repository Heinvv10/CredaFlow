import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Prisma } from "@prisma/client"

const loanAggregate = vi.fn()
const loanCount = vi.fn()
const paymentAggregate = vi.fn()
const complianceCount = vi.fn()
const complianceFindFirst = vi.fn()
const complianceFindMany = vi.fn()
const tenantConfigFindUnique = vi.fn()
const userFindUnique = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: {
      aggregate: (a: unknown) => loanAggregate(a),
      count: (a: unknown) => loanCount(a),
    },
    payment: { aggregate: (a: unknown) => paymentAggregate(a) },
    complianceRecord: {
      count: (a: unknown) => complianceCount(a),
      findFirst: (a: unknown) => complianceFindFirst(a),
      findMany: (a: unknown) => complianceFindMany(a),
    },
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUnique(a) },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
  },
}))

import {
  getNcrReturnData,
  parWhere,
  disbursedInQuarterWhere,
  receiptsInQuarterWhere,
  submissionSnapshot,
  parseFiledSnapshot,
  COLLECTIBLE_STATUSES,
} from "./ncr-return"
import { quarterBounds } from "./quarters"

const TENANT = "tenant-1"
const QUARTER = "2026-Q2"
const NOW = new Date("2026-08-16T10:00:00Z") // in 2026-Q3, so Q2 is closed

/**
 * Distinct values per call so a line that reads the wrong aggregate is visible
 * rather than coincidentally correct — a uniform stub would let every
 * population bug pass.
 */
function stubQueries() {
  loanAggregate.mockImplementation((args: { where: Prisma.LoanWhereInput }) => {
    const w = args.where as Record<string, unknown>
    const dpd = (w.daysInArrears as { gte?: number } | undefined)?.gte
    if (w.startDate) return { _count: 7, _sum: { principal: 700_00 } }
    // Write-offs key on the timestamp, not the status: the query deliberately
    // carries no status predicate so the line stays reproducible.
    if (w.writeOffAt) return { _count: 2, _sum: { outstandingPrincipal: 200_00 } }
    if (w.status === "DEFAULTED") return { _count: 3, _sum: { outstandingPrincipal: 300_00 } }
    if (dpd === 90) return { _count: 4, _sum: { outstandingPrincipal: 100_00 } }
    if (dpd === 60) return { _count: 5, _sum: { outstandingPrincipal: 200_00 } }
    if (dpd === 30) return { _count: 6, _sum: { outstandingPrincipal: 400_00 } }
    if (dpd === 1) return { _count: 8, _sum: { arrearsAmount: 50_00, outstandingPrincipal: 500_00 } }
    return { _count: 20, _sum: { outstandingPrincipal: 1000_00 } } // collectible book
  })
  loanCount.mockResolvedValue(9)
  paymentAggregate.mockImplementation((args: { where: Prisma.PaymentWhereInput }) =>
    (args.where as Record<string, unknown>).allocationStatus
      ? { _count: 10, _sum: { amount: 900_00 } }
      : { _count: 12, _sum: { amount: 1_000_00 } },
  )
  complianceCount.mockResolvedValue(11)
  complianceFindFirst.mockResolvedValue(null)
  complianceFindMany.mockResolvedValue([])
  tenantConfigFindUnique.mockResolvedValue({ ncrNumber: "NCRCP99999" })
  userFindUnique.mockResolvedValue(null)
}

const line = (data: Awaited<ReturnType<typeof getNcrReturnData>>, key: string) => {
  const found = data.lines.find((l) => l.key === key)
  if (!found) throw new Error(`no line ${key}`)
  return found
}

describe("population predicates", () => {
  it("confines every PAR band to the collectible book", () => {
    for (const days of [1, 30, 60, 90]) {
      expect(parWhere(TENANT, days)).toEqual({
        tenantId: TENANT,
        status: { in: ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"] },
        daysInArrears: { gte: days },
      })
    }
  })

  it("keeps still-owed debt in the collectible book", () => {
    // A loan parked in the write-off approval queue is still owed and is not in
    // the write-off line yet. Omitting it put such a loan in NO line at all.
    const statuses = (parWhere(TENANT, 1).status as { in: string[] }).in
    expect(statuses).toContain("PENDING_WRITE_OFF")
    expect(statuses).toContain("RESTRUCTURED")
    expect(statuses).toContain("ACTIVE")
    expect(statuses).toContain("DEFAULTED")
  })

  it("excludes settled and written-off loans from the collectible book", () => {
    // Written-off loans keep their last daysInArrears, so including them would
    // double-count against the write-off line and inflate arrears forever.
    const statuses = (parWhere(TENANT, 1).status as { in: string[] }).in
    for (const excluded of ["WRITTEN_OFF", "COMPLETED", "CANCELLED"]) {
      expect(statuses).not.toContain(excluded)
    }
  })

  it("covers every LoanStatus exactly once, as included or excluded", () => {
    // Pins the taxonomy against the enum in prisma/schema/loans-payments.prisma so a new
    // status cannot silently default to "not in the book".
    const ALL_LOAN_STATUSES = [
      "ACTIVE", "COMPLETED", "DEFAULTED", "PENDING_WRITE_OFF",
      "WRITTEN_OFF", "RESTRUCTURED", "CANCELLED",
    ]
    const included = [...COLLECTIBLE_STATUSES] as string[]
    const excluded = ALL_LOAN_STATUSES.filter((s) => !included.includes(s))
    expect(included.every((s) => ALL_LOAN_STATUSES.includes(s))).toBe(true)
    expect(included.length + excluded.length).toBe(ALL_LOAN_STATUSES.length)
    expect(excluded.sort()).toEqual(["CANCELLED", "COMPLETED", "WRITTEN_OFF"])
  })

  it("uses PAR bands at or beyond the boundary, not strictly beyond", () => {
    expect((parWhere(TENANT, 30).daysInArrears as { gte: number }).gte).toBe(30)
  })

  it("scopes period predicates to end-exclusive quarter bounds", () => {
    const { start, end } = quarterBounds(QUARTER)
    expect(disbursedInQuarterWhere(TENANT, start, end)).toEqual({
      tenantId: TENANT,
      startDate: { gte: start, lt: end },
      // A reversed disbursement (the money never reached the borrower) is not
      // a new agreement or principal disbursed.
      disbursementReversals: { none: { status: "APPROVED" } },
    })
    expect(receiptsInQuarterWhere(TENANT, start, end)).toEqual({
      tenantId: TENANT,
      reversed: false,
      receivedAt: { gte: start, lt: end },
      // A small-balance waiver is a credit, not cash that reached us.
      paymentMethod: { not: "WAIVER" },
    })
  })

  it("counts all non-reversed receipts as cash received, not only allocated ones", () => {
    // An over-payment is an ALLOCATED parent plus an UNAPPLIED child; filtering
    // on ALLOCATED would under-state the cash that actually reached us.
    expect(receiptsInQuarterWhere(TENANT, new Date(0), new Date(1)))
      .not.toHaveProperty("allocationStatus")
  })
})

describe("getNcrReturnData", () => {
  it("states the tenant's own configured NCR number", async () => {
    expect((await getNcrReturnData(TENANT, QUARTER, NOW)).ncrNumber).toBe("NCRCP99999")
  })

  // a regulator return never carries a default registration number.
  it.each([null, "", "NCR99999"])("refuses when the configured NCR number is %j", async (ncrNumber) => {
    tenantConfigFindUnique.mockResolvedValue({ ncrNumber })
    await expect(getNcrReturnData(TENANT, QUARTER, NOW)).rejects.toMatchObject({ name: "LenderIdentityError" })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  it("reports the requested quarter, not the current one", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    const { start, end } = quarterBounds(QUARTER)
    expect(data.quarter).toBe(QUARTER)
    expect(data.periodStart.toISOString()).toBe(start.toISOString())
    expect(data.periodEnd.getTime()).toBe(end.getTime() - 1)
    expect(data.quarterOpen).toBe(false)
  })

  it("queries period lines with the requested quarter's bounds", async () => {
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const { start, end } = quarterBounds(QUARTER)
    const startDateCall = loanAggregate.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => a.where.startDate)
    expect(startDateCall?.where.startDate).toEqual({ gte: start, lt: end })
    expect(paymentAggregate.mock.calls[0][0].where.receivedAt).toEqual({ gte: start, lt: end })
  })

  it("marks the open quarter as open", async () => {
    const data = await getNcrReturnData(TENANT, "2026-Q3", NOW)
    expect(data.quarterOpen).toBe(true)
  })

  it("computes every percentage over the collectible book", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.collectibleBook.value).toBe(1000_00)
    expect(line(data, "par30").percentOfBook).toBeCloseTo(40)
    expect(line(data, "par60").percentOfBook).toBeCloseTo(20)
    expect(line(data, "par90").percentOfBook).toBeCloseTo(10)
    expect(line(data, "arrears").percentOfBook).toBeCloseTo(50)
  })

  it("never prints a percentage above 100", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    for (const l of data.lines) {
      if (l.percentOfBook !== undefined) expect(l.percentOfBook).toBeLessThanOrEqual(100)
    }
  })

  it("returns 0% rather than dividing by an empty book", async () => {
    loanAggregate.mockImplementation((args: { where: Record<string, unknown> }) =>
      args.where.daysInArrears
        ? { _count: 0, _sum: { outstandingPrincipal: 0, arrearsAmount: 0 } }
        : { _count: 0, _sum: { outstandingPrincipal: null, principal: null } },
    )
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "par30").percentOfBook).toBe(0)
    expect(Number.isNaN(line(data, "par30").percentOfBook)).toBe(false)
  })

  it("states the defaulted line in outstanding principal, like the book", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    // 300_00 is the outstandingPrincipal stub; the original advance would be a
    // different, non-comparable basis.
    expect(line(data, "defaulted").value).toBe(300_00)
  })

  it("separates cash received from cash applied", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "receipts").value).toBe(1_000_00)
    expect(line(data, "applied").value).toBe(900_00)
  })

  it("classifies each line as PERIOD or POSITION", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    const basis = Object.fromEntries(data.lines.map((l) => [l.key, l.basis]))
    expect(basis).toMatchObject({
      newAgreements: "PERIOD",
      receipts: "PERIOD",
      applied: "PERIOD",
      section129: "PERIOD",
      writeOffs: "PERIOD",
      book: "POSITION",
      arrears: "POSITION",
      par30: "POSITION",
      par60: "POSITION",
      par90: "POSITION",
      defaulted: "POSITION",
      attorney: "POSITION",
    })
  })

  it("flags stale position figures for a closed, unsubmitted quarter", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.positionIsStale).toBe(true)
  })

  it("does not flag the open quarter as stale", async () => {
    const data = await getNcrReturnData(TENANT, "2026-Q3", NOW)
    expect(data.positionIsStale).toBe(false)
  })

  it("does not flag a closed quarter that has a filed snapshot", async () => {
    complianceFindMany.mockResolvedValue([{
      completedAt: new Date("2026-07-05T08:00:00Z"),
      data: {
        quarter: QUARTER,
        submittedByUserId: "user-1",
        snapshot: {
          collectibleBook: { count: 20, value: 1000_00 },
          lines: [{ key: "par30", label: "PAR30", count: 6, value: 400_00, basis: "POSITION" }],
        },
      },
    }])
    userFindUnique.mockResolvedValue({ name: "Naledi", email: "d@example.test" })
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.positionIsStale).toBe(false)
    expect(data.submittedByName).toBe("Naledi")
    expect(data.submittedAt?.toISOString()).toBe("2026-07-05T08:00:00.000Z")
  })

  it("looks up the submission for the requested quarter only", async () => {
    await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(complianceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: TENANT,
        type: "NCR_QUARTERLY_RETURN",
        status: "SUBMITTED",
        data: { path: ["quarter"], equals: QUARTER },
      }),
    }))
  })

  it("counts only delivered Section 129 notices issued in the quarter", async () => {
    const { start, end } = quarterBounds(QUARTER)
    await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(complianceCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        type: "SECTION_129_NOTICE",
        status: "COMPLETED",
        completedAt: { gte: start, lt: end },
        data: { path: ["lifecycle"], equals: "ISSUED" },
      }),
    })
  })

  it("scopes every query to the tenant", async () => {
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const wheres = [
      ...loanAggregate.mock.calls,
      ...loanCount.mock.calls,
      ...paymentAggregate.mock.calls,
      ...complianceCount.mock.calls,
    ].map(([a]) => (a as { where: Record<string, unknown> }).where)
    expect(wheres.length).toBeGreaterThan(0)
    for (const w of wheres) expect(w.tenantId).toBe(TENANT)
  })
})

describe("submissionSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  it("freezes every line so the filed figures survive later book movement", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    const snap = submissionSnapshot(data)
    expect(snap.quarter).toBe(QUARTER)
    expect(snap.lines).toHaveLength(data.lines.length)
    expect(snap.lines.map((l) => l.key)).toEqual(data.lines.map((l) => l.key))
    expect(snap.collectibleBook).toEqual({ count: 20, value: 1000_00 })
    expect(snap.lines.find((l) => l.key === "par30")).toMatchObject({
      count: 6, value: 400_00, basis: "POSITION",
    })
  })

  it("is JSON-round-trippable for storage in ComplianceRecord.data", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    const snap = submissionSnapshot(data)
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })
})

describe("every line is pinned", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  // A blind review mutated each of these and the suite stayed green: the lines
  // existed with no assertion behind them. The stub already returns
  // distinguishable values per query, so a line reading the wrong aggregate or
  // the wrong column now shows up here.

  it("states write-offs in outstanding principal, not the original advance", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "writeOffs")).toMatchObject({ count: 2, value: 200_00 })
  })

  it("windows write-offs on the write-off date, not the row's creation date", async () => {
    const { start, end } = quarterBounds(QUARTER)
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const call = loanAggregate.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => a.where.writeOffAt)
    expect(call?.where.writeOffAt).toEqual({ gte: start, lt: end })
    expect(call?.where).not.toHaveProperty("createdAt")
  })

  it("does not filter write-offs by current status, which would erase history", async () => {
    // A later transition off WRITTEN_OFF must not retroactively remove the loan
    // from a closed quarter's figure. The timestamp is the event.
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const call = loanAggregate.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => a.where.writeOffAt)
    expect(call?.where).not.toHaveProperty("status")
  })

  it("states new agreements in principal advanced", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "newAgreements")).toMatchObject({ count: 7, value: 700_00 })
  })

  it("counts new agreements with no status filter, so the line reproduces", async () => {
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const call = loanAggregate.mock.calls
      .map(([a]) => a as { where: Record<string, unknown> })
      .find((a) => a.where.startDate)
    expect(call?.where).not.toHaveProperty("status")
  })

  it("reports the Section 129 count from the statutory register", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "section129")).toMatchObject({ count: 11, value: null })
  })

  it("confines attorney referrals to the collectible book", async () => {
    // Without the book filter this counts CLOSED and WRITTEN_OFF loans that
    // were referred years ago.
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "attorney")).toMatchObject({ count: 9, value: null })
    expect(loanCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: TENANT,
        status: { in: ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"] },
        collectionsStage: "ATTORNEY_REFERRED",
      }),
    })
  })

  it("gives the book line the collectible aggregate", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "book")).toMatchObject({ count: 20, value: 1000_00 })
  })

  it("gives the arrears line the arrears balance as its value", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(line(data, "arrears")).toMatchObject({ count: 8, value: 50_00 })
  })

  it("leaves no line without an assertion in this file", async () => {
    // Guards the guard: if a line is added, this fails until it is pinned above.
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.lines.map((l) => l.key).sort()).toEqual([
      "applied", "arrears", "attorney", "book", "defaulted", "newAgreements",
      "par30", "par60", "par90", "receipts", "section129", "writeOffs",
    ])
  })
})

describe("filed snapshot round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  it("reads the filed figures back rather than leaving the snapshot write-only", async () => {
    complianceFindMany.mockResolvedValue([{
      completedAt: new Date("2026-07-05T08:00:00Z"),
      data: {
        quarter: QUARTER,
        snapshot: {
          collectibleBook: { count: 3, value: 111_00 },
          lines: [
            { key: "par30", label: "PAR30", count: 1, value: 11_00, basis: "POSITION", percentOfBook: 9.9, note: "n" },
          ],
        },
      },
    }])
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.filed).not.toBeNull()
    expect(data.filed?.collectibleBook).toEqual({ count: 3, value: 111_00 })
    expect(data.filed?.lines[0]).toEqual({
      key: "par30", label: "PAR30", count: 1, value: 11_00,
      basis: "POSITION", percentOfBook: 9.9, note: "n",
    })
    // The live lines are still computed and still differ — the filed figures
    // are the return; the live ones are today's book.
    expect(line(data, "par30").value).toBe(400_00)
  })

  it("survives a full submissionSnapshot round-trip through JSON", async () => {
    const live = await getNcrReturnData(TENANT, QUARTER, NOW)
    const stored = JSON.parse(JSON.stringify({ snapshot: submissionSnapshot(live) }))
    const parsed = parseFiledSnapshot(stored)
    expect(parsed?.lines).toHaveLength(live.lines.length)
    expect(parsed?.collectibleBook).toEqual(live.collectibleBook)
    for (const [i, l] of live.lines.entries()) {
      expect(parsed?.lines[i]).toMatchObject({
        key: l.key, label: l.label, count: l.count, value: l.value, basis: l.basis,
      })
    }
  })

  it("carries the basis note through, so a filed value and percentage stay explicable", async () => {
    const live = await getNcrReturnData(TENANT, QUARTER, NOW)
    const parsed = parseFiledSnapshot(JSON.parse(JSON.stringify({ snapshot: submissionSnapshot(live) })))
    const arrears = parsed?.lines.find((l) => l.key === "arrears")
    expect(arrears?.note).toBe(line(live, "arrears").note)
    expect(arrears?.note).toBeTruthy()
  })

  it("degrades a malformed snapshot to nothing filed rather than throwing", async () => {
    for (const bad of [null, {}, { snapshot: null }, { snapshot: {} }, { snapshot: { lines: "x" } },
                       { snapshot: { lines: [] } }, { snapshot: { lines: [{ key: 1 }] } },
                       { snapshot: { lines: [{ key: "a", label: "b", basis: "NONSENSE" }] } }]) {
      expect(parseFiledSnapshot(bad)).toBeNull()
    }
  })
})

describe("choosing which submitted row is the return", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  const withSnapshot = {
    completedAt: new Date("2026-07-05T08:00:00Z"),
    data: {
      quarter: QUARTER,
      snapshot: {
        collectibleBook: { count: 9, value: 900_00 },
        lines: [{ key: "par30", label: "FILED", count: 1, value: 1, basis: "POSITION" }],
      },
    },
  }
  // The row produced by resolving a lingering PENDING record: same instant, no
  // snapshot. Ordering by completedAt alone tied these two.
  const withoutSnapshot = { completedAt: new Date("2026-07-05T08:00:00Z"), data: { quarter: QUARTER } }

  it("prefers the row carrying readable filed figures, whatever the order", async () => {
    for (const rows of [[withoutSnapshot, withSnapshot], [withSnapshot, withoutSnapshot]]) {
      vi.clearAllMocks()
      stubQueries()
      complianceFindMany.mockResolvedValue(rows)
      const data = await getNcrReturnData(TENANT, QUARTER, NOW)
      expect(data.filed?.lines[0].label).toBe("FILED")
      expect(data.filedSnapshotUnreadable).toBe(false)
      expect(data.positionIsStale).toBe(false)
    }
  })

  it("still reports a snapshot-less submission as submitted, flagged unreadable", async () => {
    complianceFindMany.mockResolvedValue([withoutSnapshot])
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.submittedAt).not.toBeNull()
    expect(data.filed).toBeNull()
    // Must NOT read as "no return was filed" — it was filed.
    expect(data.filedSnapshotUnreadable).toBe(true)
  })

  it("distinguishes never-submitted from submitted-but-unreadable", async () => {
    complianceFindMany.mockResolvedValue([])
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    expect(data.positionIsStale).toBe(true)
    expect(data.filedSnapshotUnreadable).toBe(false)
    expect(data.submittedAt).toBeNull()
  })

  it("rejects a snapshot with any malformed line rather than filing a partial return", async () => {
    complianceFindMany.mockResolvedValue([{
      completedAt: new Date("2026-07-05T08:00:00Z"),
      data: {
        quarter: QUARTER,
        snapshot: {
          collectibleBook: { count: 1, value: 1 },
          lines: [
            { key: "a", label: "Good", count: 1, value: 1, basis: "POSITION" },
            { key: "b", label: "Bad", count: 1, value: 1, basis: "NONSENSE" },
          ],
        },
      },
    }])
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    // A return missing a statutory line, presented as "the figures as filed",
    // is worse than falling back to the live book with a caveat.
    expect(data.filed).toBeNull()
    expect(data.filedSnapshotUnreadable).toBe(true)
  })

  it("labels the book line for the population it actually covers", async () => {
    const data = await getNcrReturnData(TENANT, QUARTER, NOW)
    const label = line(data, "book").label
    expect(label).not.toContain("active + defaulted")
    // The label is frozen verbatim into every snapshot, so it must not name a
    // narrower population than COLLECTIBLE_STATUSES.
    expect(label.toLowerCase()).toContain("collectible book")
  })
})

describe("NCR return covers NCA credit agreements only", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubQueries()
  })

  it("restricts every loan and receipt figure to NCA loans", async () => {
    await getNcrReturnData(TENANT, QUARTER, NOW)
    const loanWheres = [...loanAggregate.mock.calls, ...loanCount.mock.calls].map(
      ([args]) => (args as { where: Record<string, unknown> }).where,
    )
    expect(loanWheres.length).toBeGreaterThan(0)
    for (const where of loanWheres) expect(where.ncaRegime).toBe("NCA")
    const paymentWheres = paymentAggregate.mock.calls.map(([args]) => (args as { where: Record<string, unknown> }).where)
    expect(paymentWheres.length).toBeGreaterThan(0)
    for (const where of paymentWheres) expect(where.loan).toEqual({ ncaRegime: "NCA" })
  })
})
