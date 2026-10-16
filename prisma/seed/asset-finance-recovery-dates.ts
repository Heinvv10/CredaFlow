import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"

const daysAgo = (today: string, days: number) => fromDayNumber(toDayNumber(today) - days)

export function legalMatterSeedDates(today: string) {
  const s129On = daysAgo(today, 30)
  return {
    s129On,
    attorneyAppointedOn: daysAgo(today, 25),
    summonsIssuedOn: addSouthAfricanBusinessDays(s129On, 10),
    summonsServedOn: daysAgo(today, 10),
    judgmentOn: daysAgo(today, 8),
    attachmentOrderOn: daysAgo(today, 5),
    assetRecoveredOn: daysAgo(today, 3),
  }
}
