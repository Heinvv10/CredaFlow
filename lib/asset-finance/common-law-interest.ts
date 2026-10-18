import type { DefaultChargeResult } from "@/lib/loan/default-charges"

/** Restore signed/rate-adjusted interest as a replay input, never as a bill. */
export function commonLawContractualRows<T extends { interestDue: number; totalDue: number; commonLawContractualInterestDue?: number | null }>(rows: T[]): T[] {
  return rows.map((row) => row.commonLawContractualInterestDue == null ? { ...row } : { ...row,
    interestDue: row.commonLawContractualInterestDue,
    totalDue: row.totalDue - row.interestDue + row.commonLawContractualInterestDue,
  })
}

/** Effective collectible rows; original terms survive for replay/reversals. */
export function commonLawReplayRows<T extends { interestDue: number; totalDue: number; commonLawContractualInterestDue?: number | null }>(rows: T[], result: DefaultChargeResult): T[] {
  return rows.map((row, i) => {
    const lawful = result.lawfulSchedule?.[i]
    if (!lawful) return { ...row }
    return { ...row, interestDue: lawful.interestDue, totalDue: lawful.totalDue,
      commonLawContractualInterestDue: row.commonLawContractualInterestDue != null || lawful.contractualInterestDue !== lawful.interestDue ? lawful.contractualInterestDue : null }
  })
}
