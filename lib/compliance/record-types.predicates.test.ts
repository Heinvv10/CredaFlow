import { describe, it, expect } from "vitest"
import {
  complianceWhere,
  summariseCompliance,
  OBLIGATION_TYPES,
  EXCEPTION_TYPES,
  TERMINAL_STATUSES,
  type DashboardRecord,
} from "./record-types"

/**
 * The dashboard counts its health summary in the database; `summariseCompliance`
 * states the same rules in memory. Two statements of one rule drift, so this
 * file evaluates the Prisma predicates against fixtures with a small interpreter
 * and asserts the two agree record-for-record.
 *
 * The interpreter supports only the operators the predicates actually use. It
 * throws on anything else, so a predicate that grows a new operator fails here
 * rather than silently going unchecked.
 */

const TENANT = "tenant-1"
const NOW = new Date("2026-08-16T10:00:00Z")

type Where = Record<string, unknown>

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null
  if (typeof condition !== "object") return value === condition

  const c = condition as Record<string, unknown>
  const keys = Object.keys(c)
  const unsupported = keys.filter((k) => !["in", "notIn", "lt"].includes(k))
  if (unsupported.length > 0) {
    throw new Error(`Unsupported operator(s) in predicate: ${unsupported.join(", ")}`)
  }

  if ("in" in c && !(c.in as unknown[]).includes(value)) return false
  if ("notIn" in c && (c.notIn as unknown[]).includes(value)) return false
  if ("lt" in c) {
    if (value === null || value === undefined) return false
    if (new Date(value as string | Date) >= new Date(c.lt as string | Date)) return false
  }
  return true
}

function matches(record: DashboardRecord & { tenantId: string }, where: Where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      const branches = condition as Where[]
      if (!branches.some((b) => matches(record, b))) return false
      continue
    }
    if (!matchesField((record as unknown as Record<string, unknown>)[key], condition)) {
      return false
    }
  }
  return true
}

const PAST = new Date("2026-07-01T00:00:00Z")
const FUTURE = new Date("2026-12-01T00:00:00Z")

function rec(
  type: string,
  status: string,
  dueDate: Date | null = null,
  tenantId = TENANT,
): DashboardRecord & { tenantId: string } {
  return { type, status, dueDate, tenantId }
}

// Deliberately spans every group, every status and all three due-date shapes.
const FIXTURES = [
  ...OBLIGATION_TYPES.flatMap((t) => [
    rec(t, "PENDING", PAST),
    rec(t, "PENDING", FUTURE),
    rec(t, "PENDING", null),
    rec(t, "OVERDUE", null),
    rec(t, "OVERDUE", PAST),
    ...TERMINAL_STATUSES.map((s) => rec(t, s, PAST)),
    ...TERMINAL_STATUSES.map((s) => rec(t, s, null)),
  ]),
  ...EXCEPTION_TYPES.flatMap((t) => [
    rec(t, "PENDING", null),
    rec(t, "PENDING", PAST),
    rec(t, "COMPLETED", null),
  ]),
  rec("CREDIT_BUREAU_CHECK", "PENDING", null),
  rec("AGREEMENT_ARTIFACT", "PENDING", PAST),
  rec("DEBIT_MANDATE_ARTIFACT", "OVERDUE", PAST),
]

const countWhere = (where: Where) => FIXTURES.filter((r) => matches(r, where)).length

describe("SQL predicates agree with the in-memory rules", () => {
  const expected = summariseCompliance(FIXTURES, NOW)

  it("the fixture set actually exercises each branch", () => {
    // A vacuous agreement of two zeroes would prove nothing.
    expect(expected.total).toBeGreaterThan(0)
    expect(expected.complete).toBeGreaterThan(0)
    expect(expected.overdue).toBeGreaterThan(0)
    expect(expected.openWithoutDueDate).toBeGreaterThan(0)
    expect(expected.openExceptions).toBeGreaterThan(0)
    expect(expected.score).toBeGreaterThan(0)
    expect(expected.score).toBeLessThan(100)
  })

  it("counts the same obligations", () => {
    expect(countWhere(complianceWhere.obligations(TENANT))).toBe(expected.total)
  })

  it("counts the same complete obligations", () => {
    expect(countWhere(complianceWhere.completeObligations(TENANT))).toBe(expected.complete)
  })

  it("counts the same overdue obligations", () => {
    expect(countWhere(complianceWhere.overdueObligations(TENANT, NOW))).toBe(expected.overdue)
  })

  it("counts the same open obligations without a due date", () => {
    expect(countWhere(complianceWhere.openObligationsWithoutDueDate(TENANT)))
      .toBe(expected.openWithoutDueDate)
  })

  it("counts the same open exceptions", () => {
    expect(countWhere(complianceWhere.openExceptions(TENANT))).toBe(expected.openExceptions)
  })
})

describe("predicate details", () => {
  it("scopes every predicate to the tenant", () => {
    const foreign = rec("FAIS_DISCLOSURE", "PENDING", PAST, "other-tenant")
    for (const where of [
      complianceWhere.obligations(TENANT),
      complianceWhere.completeObligations(TENANT),
      complianceWhere.overdueObligations(TENANT, NOW),
      complianceWhere.openObligationsWithoutDueDate(TENANT),
      complianceWhere.openExceptions(TENANT),
    ]) {
      expect(where).toHaveProperty("tenantId", TENANT)
      expect(matches(foreign, where as Where)).toBe(false)
    }
  })

  it("keeps register rows out of every obligation predicate", () => {
    // A PENDING, past-due agreement artifact must not read as an overdue duty.
    const register = rec("AGREEMENT_ARTIFACT", "PENDING", PAST)
    expect(matches(register, complianceWhere.obligations(TENANT) as Where)).toBe(false)
    expect(matches(register, complianceWhere.overdueObligations(TENANT, NOW) as Where)).toBe(false)
  })

  it("does not treat a deadline-less pending obligation as overdue", () => {
    const noDeadline = rec("FAIS_DISCLOSURE", "PENDING", null)
    expect(matches(noDeadline, complianceWhere.overdueObligations(TENANT, NOW) as Where)).toBe(false)
    expect(matches(noDeadline, complianceWhere.openObligationsWithoutDueDate(TENANT) as Where)).toBe(true)
  })

  it("treats an explicitly OVERDUE record with no deadline as overdue, not as open-without-deadline", () => {
    const flagged = rec("FAIS_DISCLOSURE", "OVERDUE", null)
    expect(matches(flagged, complianceWhere.overdueObligations(TENANT, NOW) as Where)).toBe(true)
    expect(matches(flagged, complianceWhere.openObligationsWithoutDueDate(TENANT) as Where)).toBe(false)
  })

  it("never counts a terminal record as overdue, however old its deadline", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(matches(rec("FAIS_DISCLOSURE", status, PAST), complianceWhere.overdueObligations(TENANT, NOW) as Where))
        .toBe(false)
    }
  })

  it("counts ACKNOWLEDGED towards complete", () => {
    expect(matches(rec("SECTION_129_NOTICE", "ACKNOWLEDGED", PAST), complianceWhere.completeObligations(TENANT) as Where))
      .toBe(true)
  })
})
