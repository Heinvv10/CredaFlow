import { NextResponse } from "next/server"
import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "@/lib/asset-finance/dates"
import { repoRateIsPlausible } from "@/lib/asset-finance/reference-rate-input"
import {
  checkNcaInterestRate,
  checkRepeatShortTermRate,
  NCA_INTEREST_CAP,
  ncaCreditType,
  type InterestRateCapResult,
  type NcaCreditType,
} from "@/lib/loan/nca-interest-cap"

type RepoDb = Pick<typeof prisma, "referenceRate">

/**
 * The repo rate the cap is computed from on `day`: the latest APPROVED value,
 * or a newer value the SARB feed recorded (still PENDING approval) if that is
 * LOWER. A cut the lender has not yet approved must lower the cap at once; a
 * rise only counts once a person approves it. null when nothing is approved.
 */
export async function capRepoRate(db: RepoDb, tenantId: string, day: string): Promise<{ rate: number; approved: number } | null> {
  const approved = await db.referenceRate.findFirst({
    where: { tenantId, basis: "REPO", status: "APPROVED", effectiveDate: { lte: dbDate(day) } },
    orderBy: { effectiveDate: "desc" },
    select: { effectiveDate: true, rate: true },
  })
  if (!approved) return null
  const fed = await db.referenceRate.findMany({
    where: { tenantId, basis: "REPO", source: "SARB_FEED", status: "PENDING", effectiveDate: { gt: approved.effectiveDate, lte: dbDate(day) } },
    select: { rate: true },
  })
  const approvedRate = approved.rate.toNumber()
  return { rate: Math.min(approvedRate, ...fed.map((row) => row.rate.toNumber())), approved: approvedRate }
}

/** checkNcaInterestRate against the tenant's repo rate in effect on `on` (SAST day). */
export async function checkNcaInterestRateFor(
  db: RepoDb,
  tenantId: string,
  args: { creditType: NcaCreditType; interestRatePm: number; interestModel: string },
  on: Date = new Date(),
): Promise<InterestRateCapResult> {
  // Short-term caps are a flat monthly rate: no repo needed.
  if (args.creditType === "SHORT_TERM") return checkNcaInterestRate({ ...args, repoAnnualRate: null })
  const repo = await capRepoRate(db, tenantId, sastCalendarDate(on))
  if (repo && !repoRateIsPlausible(repo.approved)) {
    return {
      ok: false,
      reason: "REPO_IMPLAUSIBLE",
      message: `The approved repo rate of ${(repo.approved * 100).toFixed(2)}% is outside the plausible 1%–20% band, so the NCA cap cannot be set from it. Record the correct SARB repo rate under Settings → Repo rate.`,
    }
  }
  return checkNcaInterestRate({ ...args, repoAnnualRate: repo ? repo.rate : null })
}

type ApprovalDb = RepoDb & Pick<typeof prisma, "loan">

/** The client's earlier short-term loans with this lender in the SAST calendar year of `on`. */
export async function earlierShortTermLoansThisYear(db: Pick<typeof prisma, "loan">, tenantId: string, clientId: string, on: Date): Promise<number> {
  const year = sastCalendarDate(on).slice(0, 4)
  const loans = await db.loan.findMany({
    where: {
      tenantId, clientId, status: { not: "CANCELLED" },
      startDate: { gte: new Date(`${year}-01-01T00:00:00+02:00`), lte: on },
      principal: { lte: NCA_INTEREST_CAP.shortTermMaxPrincipalCents },
    },
    select: { startDate: true, maturityDate: true },
  })
  const days = (loan: { startDate: Date; maturityDate: Date }) => Math.round((loan.maturityDate.getTime() - loan.startDate.getTime()) / 86_400_000)
  return loans.filter((loan) => days(loan) <= NCA_INTEREST_CAP.shortTermMaxTermDays).length
}

/**
 * The 422 an approval answers when the product's rate exceeds the NCA cap for
 * this transaction (lib/loan/nca-interest-cap.ts), or null. A NON_NCA
 * (asset-finance) agreement is outside Regulation 42. A short-term transaction
 * after an earlier one this calendar year is held to 3% a month; it is
 * refused, never re-priced: repeat pricing is a product decision.
 */
export async function approvalInterestCapRefusal(
  db: ApprovalDb,
  tenantId: string,
  application: {
    ncaRegime: string | null; clientId: string | null; appliedAmount: number; appliedTermDays: number
    product: { interestRatePm: number; interestModel: string }
  },
  on: Date = new Date(),
): Promise<NextResponse | null> {
  if (application.ncaRegime === "NON_NCA") return null
  const creditType = ncaCreditType(application.appliedAmount, application.appliedTermDays)
  const { interestRatePm, interestModel } = application.product
  let result = await checkNcaInterestRateFor(db, tenantId, { creditType, interestRatePm, interestModel }, on)
  if (result.ok && creditType === "SHORT_TERM" && application.clientId) {
    result = checkRepeatShortTermRate(interestRatePm, await earlierShortTermLoansThisYear(db, tenantId, application.clientId, on))
  }
  return result.ok
    ? null
    : NextResponse.json({ error: `Approval blocked: ${result.message}`, interestRateCap: result.reason, requiresOverride: false }, { status: 422 })
}
