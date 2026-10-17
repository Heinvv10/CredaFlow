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
 * or a newer value the SARB feed recorded if that is LOWER. A cut the lender
 * has not approved must lower the cap at once; a rise only counts once a
 * person approves it. A REJECTED feed value still counts: a fed row has no
 * requester, so one person could otherwise reject a cut and restore the higher
 * cap, and the feed does not ask again. Only a later APPROVED value displaces
 * it: a MANUAL one needs two people (CHECK ReferenceRate_four_eyes). null when
 * nothing is approved.
 */
export async function capRepoRate(db: RepoDb, tenantId: string, day: string): Promise<{ rate: number; approved: number } | null> {
  const approved = await db.referenceRate.findFirst({
    where: { tenantId, basis: "REPO", status: "APPROVED", effectiveDate: { lte: dbDate(day) } },
    orderBy: { effectiveDate: "desc" },
    select: { effectiveDate: true, rate: true },
  })
  if (!approved) return null
  const fed = await db.referenceRate.findMany({
    where: { tenantId, basis: "REPO", source: "SARB_FEED", status: { in: ["PENDING", "REJECTED"] }, effectiveDate: { gt: approved.effectiveDate, lte: dbDate(day) } },
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

type ShortTermDb = Pick<typeof prisma, "loan" | "loanApplication">
type ApprovalDb = RepoDb & ShortTermDb

/** The application a repeat short-term check is for: its approval orders it among the client's credit. */
export interface ShortTermSubject {
  id: string
  approvedAt?: Date | null
}

/**
 * The client's short-term credit with this lender in the SAST calendar year of
 * `on` that came before `subject`: loans paid out (not CANCELLED) and
 * applications APPROVED but not yet paid out, each approved before the
 * subject was (before `on` while it is being approved). Ordered by approval,
 * so a payout re-check counts the same credit the approval did, plus any
 * approved meanwhile ahead of it, and two approvals that raced count each
 * other once.
 */
export async function earlierShortTermCreditThisYear(
  db: ShortTermDb, tenantId: string, clientId: string, on: Date, subject: ShortTermSubject,
): Promise<number> {
  const yearStart = new Date(`${sastCalendarDate(on).slice(0, 4)}-01-01T00:00:00+02:00`)
  const before = subject.approvedAt ?? on
  const [loans, approved] = await Promise.all([
    db.loan.findMany({
      where: {
        tenantId, clientId, status: { not: "CANCELLED" }, applicationId: { not: subject.id },
        startDate: { gte: yearStart, lte: on },
        principal: { lte: NCA_INTEREST_CAP.shortTermMaxPrincipalCents },
        OR: [{ application: { approvedAt: { lt: before } } }, { application: { approvedAt: null } }],
      },
      select: { startDate: true, maturityDate: true },
    }),
    db.loanApplication.findMany({
      where: { tenantId, clientId, status: "APPROVED", loan: null, id: { not: subject.id }, approvedAt: { gte: yearStart, lt: before } },
      select: { appliedAmount: true, appliedTermDays: true, approvedAmount: true, approvedTermDays: true },
    }),
  ])
  const days = (loan: { startDate: Date; maturityDate: Date }) => Math.round((loan.maturityDate.getTime() - loan.startDate.getTime()) / 86_400_000)
  return loans.filter((loan) => days(loan) <= NCA_INTEREST_CAP.shortTermMaxTermDays).length
    + approved.filter((app) => ncaCreditType(app.approvedAmount ?? app.appliedAmount, app.approvedTermDays ?? app.appliedTermDays) === "SHORT_TERM").length
}

type CapApplication = ShortTermSubject & {
  ncaRegime: string | null; clientId: string | null; appliedAmount: number; appliedTermDays: number
  product: { interestRatePm: number; interestModel: string }
}

/** Regulation 42's 3% a month on a short-term transaction after an earlier one this calendar year. */
export async function checkRepeatShortTermFor(db: ShortTermDb, tenantId: string, application: CapApplication, on: Date): Promise<InterestRateCapResult> {
  if (application.ncaRegime === "NON_NCA" || !application.clientId) return { ok: true }
  if (ncaCreditType(application.appliedAmount, application.appliedTermDays) !== "SHORT_TERM") return { ok: true }
  const earlier = await earlierShortTermCreditThisYear(db, tenantId, application.clientId, on, application)
  return checkRepeatShortTermRate(application.product.interestRatePm, earlier)
}

/**
 * The 422 an approval answers when the product's rate exceeds the NCA cap for
 * this transaction (lib/loan/nca-interest-cap.ts), or null. A NON_NCA
 * (asset-finance) agreement is outside Regulation 42. A short-term transaction
 * after an earlier one this calendar year is held to 3% a month; it is
 * refused, never re-priced: repeat pricing is a product decision. The payout
 * re-checks the repeat rule (lib/affordability/current-approval.ts).
 */
export async function approvalInterestCapRefusal(
  db: ApprovalDb,
  tenantId: string,
  application: CapApplication,
  on: Date = new Date(),
): Promise<NextResponse | null> {
  if (application.ncaRegime === "NON_NCA") return null
  const creditType = ncaCreditType(application.appliedAmount, application.appliedTermDays)
  const { interestRatePm, interestModel } = application.product
  let result = await checkNcaInterestRateFor(db, tenantId, { creditType, interestRatePm, interestModel }, on)
  if (result.ok) result = await checkRepeatShortTermFor(db, tenantId, application, on)
  return result.ok
    ? null
    : NextResponse.json({ error: `Approval blocked: ${result.message}`, interestRateCap: result.reason, requiresOverride: false }, { status: 422 })
}
