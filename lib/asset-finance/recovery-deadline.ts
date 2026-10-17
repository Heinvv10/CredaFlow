import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"

// Charge freeze after a recovery's sale proceeds are applied. Dates are SAST
// calendar days (YYYY-MM-DD). Both ends are inclusive: no default interest,
// fee or charge accrues from `frozenFrom` through `frozenUntil`.
//  - NCA: the debtor has 10 business days from the final notice (s127(8)).
//  - NON_NCA: the lender's contractual demand period, in calendar days from
//    the proceeds date (TenantConfig.nonNcaDemandPeriodDays).
// The s127(8) reading and the freeze start are signed off (see DESIGN.md sign-off record 2026-10-17).

const NCA_FINAL_NOTICE_BUSINESS_DAYS = 10

export interface RecoveryChargeFreezeInput {
  regime: "NCA" | "NON_NCA"
  proceedsAppliedOn: string
  finalNoticeIssuedOn?: string
  nonNcaDemandPeriodDays: number
}

export interface RecoveryChargeFreeze {
  frozenFrom: string
  frozenUntil: string
}

function addCalendarDays(day: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`Invalid ISO calendar date: ${day}`)
  const date = new Date(`${day}T12:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) throw new RangeError(`Invalid ISO calendar date: ${day}`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function recoveryChargeFreeze(input: RecoveryChargeFreezeInput): RecoveryChargeFreeze {
  const frozenFrom = input.proceedsAppliedOn
  addCalendarDays(frozenFrom, 0)
  if (input.regime === "NCA") {
    const notice = input.finalNoticeIssuedOn
    if (!notice) throw new RangeError("An NCA recovery needs the final notice date to set the charge freeze")
    addCalendarDays(notice, 0)
    if (notice < frozenFrom) throw new RangeError("The final notice cannot be dated before the sale proceeds")
    return { frozenFrom, frozenUntil: addSouthAfricanBusinessDays(notice, NCA_FINAL_NOTICE_BUSINESS_DAYS) }
  }
  if (!Number.isSafeInteger(input.nonNcaDemandPeriodDays) || input.nonNcaDemandPeriodDays < 0) {
    throw new RangeError("The demand period must be a non-negative whole number of days")
  }
  return { frozenFrom, frozenUntil: addCalendarDays(frozenFrom, input.nonNcaDemandPeriodDays) }
}
