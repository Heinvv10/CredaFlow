import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { repriceLoanForReference, type NotEligibleReason, type RepriceTx } from "./reprice-loan"
import { BASE, PATTERNS, solvePattern, storedRows } from "./__tests__/schedule-fixtures"
import { fromDayNumber, toDayNumber } from "./dates"
import { periodInterest } from "./amortise"
import { dueDateInstant, type ScheduleRecordAmounts } from "./schedule-records"
import type { StoredScheduleRow } from "./stored-schedule"

// The eligibility guards with the database faked. Each refusal must leave
// every table untouched. The re-solve and its writes against a real database
// are in reprice-loan.integration.test.ts.

const BOOKED = solvePattern(PATTERNS.MONTHLY)
const E = BOOKED.rows[11].dueDate // 2027-01-15
const ACTIVE_LOAN = {
  id: "loan1", reference: "LN-1", status: "ACTIVE", contractType: "INSTALMENT_SALE", ncaRegime: "NON_NCA",
  entityId: "e1", balloonAmount: BASE.balloonCents, startDate: dueDateInstant(BASE.startDate), interestRatePm: 0.1275 / 12,
}
const PRIOR = { basis: "PRIME", margin: new Prisma.Decimal("0.01"), resultingRate: new Prisma.Decimal("0.1275"), effectiveDate: new Date(`${BASE.startDate}T00:00:00Z`) }

interface Where { effectiveDate?: Date | { gt?: Date; lt?: Date }; newInstalmentCents?: unknown }

function fakeTx(state: {
  loan?: Record<string, unknown> | null
  existing?: boolean
  later?: boolean
  prior?: Record<string, unknown> | null
  reference?: boolean
  paidRows?: number
  stored?: StoredScheduleRow[]
}) {
  const contractRateFindFirst = vi.fn(async ({ where }: { where: Where }) => {
    const date = where.effectiveDate
    if (date instanceof Date) return state.existing ? { id: "cr-existing" } : null
    if (date?.gt) return state.later ? { id: "cr-later" } : null
    if (where.newInstalmentCents) return { newInstalmentCents: BOOKED.baseInstalmentCents }
    return state.prior === undefined ? PRIOR : state.prior
  })
  const writes = {
    contractRateCreate: vi.fn(),
    scheduleUpdate: vi.fn(),
    loanUpdate: vi.fn(),
    auditCreate: vi.fn(),
    notificationCreate: vi.fn(),
  }
  const referenceFindFirst = vi.fn(async () => (state.reference === false ? null : { effectiveDate: new Date(`${E}T00:00:00Z`), rate: new Prisma.Decimal("0.12") }))
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(),
    loan: { findFirst: vi.fn(async () => (state.loan === undefined ? ACTIVE_LOAN : state.loan)), updateMany: writes.loanUpdate },
    contractRate: {
      findFirst: contractRateFindFirst,
      findMany: vi.fn(async () => [{ effectiveDate: PRIOR.effectiveDate, resultingRate: PRIOR.resultingRate }]),
      create: writes.contractRateCreate,
    },
    referenceRate: { findFirst: referenceFindFirst },
    repaymentSchedule: { findMany: vi.fn(async () => state.stored ?? storedRows(BOOKED, state.paidRows ?? 11)), updateMany: writes.scheduleUpdate },
    auditLog: { create: writes.auditCreate },
    entityRelationship: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    notification: { createMany: writes.notificationCreate },
  }
  return { tx: tx as unknown as RepriceTx, writes, referenceFindFirst }
}

const request = (runDate = E) => ({ tenantId: "t1", loanId: "loan1", basis: "PRIME" as const, effectiveDate: E, runDate })

describe("repriceLoanForReference eligibility guards", () => {
  let fake: ReturnType<typeof fakeTx>
  beforeEach(() => vi.clearAllMocks())

  const cases: Array<[NotEligibleReason, Parameters<typeof fakeTx>[0], string?]> = [
    ["loan_not_found", { loan: null }],
    ["not_active", { loan: { ...ACTIVE_LOAN, status: "COMPLETED" } }],
    ["not_asset_finance", { loan: { ...ACTIVE_LOAN, contractType: "LOAN" } }],
    ["nca_regime", { loan: { ...ACTIVE_LOAN, ncaRegime: "NCA" } }],
    ["superseded", { later: true }],
    ["not_linked_to_basis", { prior: { ...PRIOR, basis: "REPO" } }],
    ["not_linked_to_basis", { prior: { ...PRIOR, basis: "FIXED", margin: null } }],
    ["not_linked_to_basis", { prior: null }],
    ["no_reference_rate", { reference: false }],
    // One pending row left, due the day after the run: inside the notice window.
    ["within_notice_period", { paidRows: 58 }, fromDayNumber(toDayNumber(BOOKED.rows[59].dueDate) - 1)],
  ]
  it.each(cases)("%s, writing nothing", async (reason, state, runDate) => {
    fake = fakeTx(state)
    expect(await repriceLoanForReference(fake.tx, request(runDate))).toEqual({ kind: "not_eligible", reason })
    for (const write of Object.values(fake.writes)) expect(write).not.toHaveBeenCalled()
  })

  it("balloon_reached, not an error, when the balance after the last settled row is the balloon", async () => {
    // Every row but the last settled; the last pays only its interest and the
    // balloon, so the balance it opens at (the one after row 59) is the balloon.
    const rows = storedRows(BOOKED, 58)
    const last = rows[59]
    const days = toDayNumber(BOOKED.rows[59].dueDate) - toDayNumber(BOOKED.rows[58].dueDate)
    const interest = periodInterest(BASE.balloonCents, 0.1275 * days)
    const amounts: Partial<ScheduleRecordAmounts> = { principalDue: BASE.balloonCents, interestDue: interest, totalDue: BASE.balloonCents + interest }
    rows[59] = { ...last, ...amounts }
    fake = fakeTx({ stored: rows })
    expect(await repriceLoanForReference(fake.tx, request())).toEqual({ kind: "not_eligible", reason: "balloon_reached" })
    for (const write of Object.values(fake.writes)) expect(write).not.toHaveBeenCalled()
  })

  it("answers already_repriced before any guard when the loan has a rate from that date", async () => {
    fake = fakeTx({ existing: true, loan: { ...ACTIVE_LOAN, status: "COMPLETED" } })
    expect(await repriceLoanForReference(fake.tx, request())).toEqual({ kind: "already_repriced" })
    for (const write of Object.values(fake.writes)) expect(write).not.toHaveBeenCalled()
  })

  it("reads only an APPROVED reference rate", async () => {
    fake = fakeTx({ reference: false })
    await repriceLoanForReference(fake.tx, request())
    expect(fake.referenceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "t1", basis: "PRIME", status: "APPROVED" }),
    }))
  })
})
