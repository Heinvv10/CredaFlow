/**
 * The CPA s14 expiry notice of a fixed-term lease (slice 3, C7). Pure.
 * A consumer lessee is told, from 80 down to 40 business days before the
 * fixed term expires, that it is expiring and what happens next (s14(2)(c)
 * as we read it). The daily lease cron queues it once per lease
 * (./lease-expiry-store.ts). // UNTESTED: legal — the window and its content.
 */
import { isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"
import { fromDayNumber, toDayNumber } from "./dates"

export const EXPIRY_NOTICE_MAX_BUSINESS_DAYS = 80
export const EXPIRY_NOTICE_MIN_BUSINESS_DAYS = 40

/** South African business days in (today, expiryDate]. */
export function businessDaysBefore(today: string, expiryDate: string): number {
  let count = 0
  for (let day = toDayNumber(today) + 1; day <= toDayNumber(expiryDate); day++) {
    if (isSouthAfricanBusinessDate(fromDayNumber(day))) count++
  }
  return count
}

export function expiryNoticeDue(input: { today: string; expiryDate: string; cpaApplies: boolean }): boolean {
  if (!input.cpaApplies) return false
  const days = businessDaysBefore(input.today, input.expiryDate)
  return days >= EXPIRY_NOTICE_MIN_BUSINESS_DAYS && days <= EXPIRY_NOTICE_MAX_BUSINESS_DAYS
}
