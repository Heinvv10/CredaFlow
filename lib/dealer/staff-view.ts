/**
 * What the staff dealer pages read (app/(dashboard)/asset-finance/dealers/**,
 * dealer-runs/**; manage_dealers). Whitelist selects: a dealer user's
 * password hash and set-password token hash are never read, only whether a
 * password is set and whether a link is pending.
 */
import { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "@/lib/asset-finance/dates"

const LINE_SELECT = {
  id: true, kind: true, reason: true, effectiveOn: true, baseCents: true, bps: true, flatCents: true,
  netCents: true, vatCents: true, grossCents: true, reversesLineId: true, createdAt: true,
  deal: { select: { id: true, application: { select: { reference: true } } } },
  loan: { select: { reference: true } },
  runLinks: { where: { voided: false }, select: { runId: true } },
} as const

export async function listDealersForStaff(tenantId: string) {
  const dealers = await prisma.dealer.findMany({
    where: { tenantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: 500,
    select: {
      id: true, name: true, kind: true, active: true, vatVendor: true, contactEmail: true,
      users: { where: { active: true }, select: { id: true } },
      bankAccounts: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { status: true } },
    },
  })
  return dealers.map(({ users, bankAccounts, ...dealer }) => ({
    ...dealer,
    activeUsers: users.length,
    hasApprovedAccount: bankAccounts.some((a) => a.status === "APPROVED"),
    pendingAccounts: bankAccounts.filter((a) => a.status === "PENDING").length,
  }))
}

/** The tenant default rate history, newest first. */
export async function defaultRateHistory(tenantId: string) {
  const rows = await prisma.dealerCommissionRate.findMany({
    where: { tenantId, dealerId: null },
    orderBy: { effectiveFrom: "desc" },
    select: { id: true, effectiveFrom: true, bps: true, flatCents: true, createdAt: true, createdBy: { select: { name: true, email: true } } },
  })
  return rows.map((row) => ({ ...row, effectiveFrom: isoOfDbDate(row.effectiveFrom) }))
}

export async function loadDealerForStaff(tenantId: string, dealerId: string) {
  const dealer = await prisma.dealer.findFirst({
    where: { id: dealerId, tenantId },
    select: {
      id: true, name: true, kind: true, registrationNumber: true, vatNumber: true, vatVendor: true,
      contactEmail: true, contactPhone: true, active: true, deactivatedAt: true, createdAt: true,
      supplier: { select: { id: true, name: true } },
      users: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true,
          setPasswordTokenExp: true,
        },
      },
      commissionRates: {
        orderBy: { effectiveFrom: "desc" },
        select: { id: true, effectiveFrom: true, bps: true, flatCents: true, createdAt: true, createdBy: { select: { name: true, email: true } } },
      },
      bankAccounts: { orderBy: { createdAt: "desc" } },
      commissionLines: { orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }], take: 500, select: LINE_SELECT },
      payableRuns: {
        orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
        select: { id: true, periodEnd: true, status: true, totalNetCents: true, totalVatCents: true, totalGrossCents: true, createdAt: true },
      },
    },
  })
  if (!dealer) return null
  const passwordSet = await prisma.dealerUser.findMany({
    where: { tenantId, dealerId, passwordHash: { not: null } },
    select: { id: true },
  })
  const hasPassword = new Set(passwordSet.map((u) => u.id))
  const now = Date.now()
  return {
    ...dealer,
    users: dealer.users.map(({ setPasswordTokenExp, ...user }) => ({
      ...user,
      passwordSet: hasPassword.has(user.id),
      linkPendingUntil: setPasswordTokenExp && setPasswordTokenExp.getTime() > now ? setPasswordTokenExp : null,
    })),
    commissionRates: dealer.commissionRates.map((r) => ({ ...r, effectiveFrom: isoOfDbDate(r.effectiveFrom) })),
    commissionLines: dealer.commissionLines.map((l) => ({ ...l, effectiveOn: isoOfDbDate(l.effectiveOn), runId: l.runLinks[0]?.runId ?? null })),
    payableRuns: dealer.payableRuns.map((r) => ({ ...r, periodEnd: isoOfDbDate(r.periodEnd) })),
  }
}

export type StaffDealerDetail = NonNullable<Awaited<ReturnType<typeof loadDealerForStaff>>>

const PERSON = { select: { id: true, name: true, email: true } } as const

/** A run's statement: the run, its dealer and account, and its live lines. */
export async function loadRunStatement(tenantId: string, runId: string) {
  const run = await prisma.dealerPayableRun.findFirst({
    where: { id: runId, tenantId },
    select: {
      id: true, periodEnd: true, status: true, totalNetCents: true, totalVatCents: true, totalGrossCents: true,
      createdAt: true, createdById: true, approvedAt: true, releasedAt: true, releaseReference: true, cancelledAt: true,
      createdBy: PERSON, approvedBy: PERSON, releasedBy: PERSON, cancelledBy: PERSON,
      dealer: { select: { id: true, name: true, vatNumber: true, vatVendor: true } },
      bankAccount: { select: { id: true, bankName: true, branchCode: true, accountNumber: true, accountHolder: true, status: true } },
      lines: { orderBy: { createdAt: "asc" }, select: { voided: true, line: { select: LINE_SELECT } } },
    },
  })
  if (!run) return null
  return {
    ...run,
    periodEnd: isoOfDbDate(run.periodEnd),
    lines: run.lines.map(({ voided, line }) => ({ ...line, voided, effectiveOn: isoOfDbDate(line.effectiveOn) })),
  }
}

export type RunStatement = NonNullable<Awaited<ReturnType<typeof loadRunStatement>>>
