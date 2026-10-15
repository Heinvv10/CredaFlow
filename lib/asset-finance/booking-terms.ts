// What booking checks a deal against, shared by the instalment-sale and lease
// booking paths (./booking.ts, ./lease-booking.ts): the race error a pinned
// status move throws, and the contract terms fixed when the documents were
// prepared (./signing-prepare.ts).
import type { Prisma } from "@prisma/client"
import type { BookingDeal } from "./booking-load"
import { isoOfDbDate } from "./dates"

export class BookingRaceError extends Error {
  constructor(what: string) {
    super(`${what} changed while the deal was being booked; nothing was booked`)
    this.name = "BookingRaceError"
  }
}

export interface SignedTerms {
  startDate: string
  baseInstalmentCents: number
  resultingRate: Prisma.Decimal
  totalInterestCents: number
  arrearsMarginRate: Prisma.Decimal | null
  collectionFeeCents: number
}

/** The terms fixed at preparation; null if the deal was never prepared (CHECK: all or none). */
export function signedTerms(deal: BookingDeal): SignedTerms | null {
  const { plannedStartDate, signedBaseInstalmentCents, signedResultingRate, signedTotalInterestCents, signedArrearsMarginRate, signedCollectionFeeCents } = deal
  if (plannedStartDate === null || signedBaseInstalmentCents === null || signedResultingRate === null
    || signedTotalInterestCents === null || signedCollectionFeeCents === null) return null
  return {
    startDate: isoOfDbDate(plannedStartDate),
    baseInstalmentCents: signedBaseInstalmentCents,
    resultingRate: signedResultingRate,
    totalInterestCents: signedTotalInterestCents,
    arrearsMarginRate: signedArrearsMarginRate,
    collectionFeeCents: signedCollectionFeeCents,
  }
}

