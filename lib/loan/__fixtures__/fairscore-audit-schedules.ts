/**
 * Synthetic schedules shaped like the two Fair Score demo loans the
 * 2026-10-16 audit read (.claude/handoffs/2026-10-16-fairscore-audit-findings.md).
 * Figures are the ones the audit quoted; names and ids are synthetic.
 *
 * Elize: 18 monthly instalments of R2,541.00 from 17 May 2026. #1–#4 paid,
 * #5 (due 17 Sep 2026) short by R843.30, #6–#18 not yet due. The portal showed
 * every one of #6–#18 as PARTIAL.
 *
 * Kabelo: 12 monthly instalments of R2,253.75 from 1 Mar 2026, #1–#3 paid,
 * nothing since. The reminder cron told him "your loan payment of R 0.00 is
 * due" for the Jun/Jul instalments, because every unpaid row was stored PARTIAL.
 */
export type FixtureScheduleRow = {
  id: string
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  totalPaid: number
  status: "PENDING" | "PARTIAL" | "PAID" | "OVERDUE"
  paidAt: Date | null
}

function monthly(
  prefix: string,
  count: number,
  first: { year: number; month: number; day: number },
  totalDue: number,
  paidOf: (no: number) => number,
): FixtureScheduleRow[] {
  return Array.from({ length: count }, (_, i) => {
    const no = i + 1
    // 08:00 SAST, the time the schedule writer stamps.
    const dueDate = new Date(Date.UTC(first.year, first.month - 1 + i, first.day, 6))
    const totalPaid = paidOf(no)
    const interestDue = Math.round(totalDue * 0.3)
    const feesDue = 6_900
    return {
      id: `${prefix}-s${no}`,
      installmentNo: no,
      dueDate,
      principalDue: totalDue - interestDue - feesDue,
      interestDue,
      feesDue,
      totalDue,
      totalPaid,
      status: totalPaid >= totalDue ? "PAID" : totalPaid > 0 ? "PARTIAL" : "PENDING",
      paidAt: totalPaid >= totalDue ? dueDate : null,
    }
  })
}

export const ELIZE_INSTALMENT_CENTS = 254_100
export const ELIZE_SHORT_CENTS = 84_330

/** Elize as she should be stored: #5 PARTIAL, #6–#18 PENDING. */
export function elizeSchedule(): FixtureScheduleRow[] {
  return monthly("elize", 18, { year: 2026, month: 5, day: 17 }, ELIZE_INSTALMENT_CENTS, (no) =>
    no <= 4 ? ELIZE_INSTALMENT_CENTS : no === 5 ? ELIZE_INSTALMENT_CENTS - ELIZE_SHORT_CENTS : 0,
  )
}

/** Elize as the audit found her: every unpaid future row stored PARTIAL. */
export function elizeScheduleAsAudited(): FixtureScheduleRow[] {
  return elizeSchedule().map((row) => (row.installmentNo > 5 ? { ...row, status: "PARTIAL" } : row))
}

export const KABELO_INSTALMENT_CENTS = 225_375

/** Kabelo as the audit found him: #1–#3 paid, every later row stored PARTIAL with nothing paid. */
export function kabeloScheduleAsAudited(): FixtureScheduleRow[] {
  return monthly("kabelo", 12, { year: 2026, month: 3, day: 1 }, KABELO_INSTALMENT_CENTS, (no) =>
    no <= 3 ? KABELO_INSTALMENT_CENTS : 0,
  ).map((row) => (row.installmentNo > 3 ? { ...row, status: "PARTIAL" } : row))
}
