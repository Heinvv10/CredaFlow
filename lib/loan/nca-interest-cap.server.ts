import { sastCalendarDate } from "@/lib/date/sast"
import { referenceRateOn, type RatesDb } from "@/lib/asset-finance/rates-store"
import { checkNcaInterestRate, type InterestRateCapResult, type NcaCreditType } from "@/lib/loan/nca-interest-cap"

/** checkNcaInterestRate against the tenant's approved repo rate in effect on `on` (SAST day). */
export async function checkNcaInterestRateFor(
  db: Pick<RatesDb, "referenceRate">,
  tenantId: string,
  args: { creditType: NcaCreditType; interestRatePm: number; interestModel: string },
  on: Date = new Date(),
): Promise<InterestRateCapResult> {
  // Short-term caps are a flat monthly rate: no repo needed.
  const repo = args.creditType === "UNSECURED"
    ? await referenceRateOn(db as RatesDb, tenantId, "REPO", sastCalendarDate(on))
    : null
  return checkNcaInterestRate({ ...args, repoAnnualRate: repo ? repo.rate.toNumber() : null })
}
