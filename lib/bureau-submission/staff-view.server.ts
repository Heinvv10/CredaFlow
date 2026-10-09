import { prisma } from "@/lib/prisma"
import { resolveFeatureFlags } from "@/lib/tenant"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { submissionMode } from "./generate"
import type { AdverseStatus } from "./map-loan"
import { dayOf, dayStart, dbDateToDay } from "./period"
import { REPORTED_PRODUCT_TYPES } from "./population"

// Reads for the staff page. Server-only. Every query carries the tenant id.

/**
 * The per-tenant switch, read LIVE: getTenantConfig is cached for five
 * minutes, and a switch that cannot be pulled at once is not a switch. Fails
 * closed on any throw.
 */
export async function isBureauSubmissionEnabled(tenantId: string): Promise<boolean> {
  try {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureCrm: true, featureIms: true, featureBureauSubmission: true },
    })
    return resolveFeatureFlags(config).featureBureauSubmission
  } catch {
    return false
  }
}

export interface AwaitingAdverse {
  loanId: string
  reference: string
  statusCode: AdverseStatus
  /** the write-off or referral date the status would be dated */
  eventDay: string | null
}

/** Whether a loan is in the state an adverse status is confirmed for. */
export function adverseEventDay(
  loan: { status: string; writeOffAt: Date | null; collectionsStage: string; attorneyReferral: { referralDate: Date } | null },
  statusCode: AdverseStatus,
): { awaiting: boolean; eventDay: string | null } {
  if (statusCode === "W") {
    // dayOf, not dbDateToDay: these are instants, and the file dates them in SAST.
    return { awaiting: loan.status === "WRITTEN_OFF", eventDay: loan.writeOffAt ? dayOf(loan.writeOffAt) : null }
  }
  return {
    awaiting: loan.collectionsStage === "ATTORNEY_REFERRED" && (COLLECTIBLE_STATUSES as readonly string[]).includes(loan.status),
    eventDay: loan.attorneyReferral ? dayOf(loan.attorneyReferral.referralDate) : null,
  }
}

/**
 * Loans that would be listed as written off (W) or handed over (L) but have
 * no staff confirmation yet. Until one exists they report arrears with no
 * status code.
 */
export async function listAwaitingAdverse(tenantId: string): Promise<AwaitingAdverse[]> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { bureauReportingStartDate: true } })
  if (!config?.bureauReportingStartDate) return []
  const reportingStart = dayStart(dbDateToDay(config.bureauReportingStartDate))
  const loans = await prisma.loan.findMany({
    where: {
      tenantId,
      product: { productType: { in: [...REPORTED_PRODUCT_TYPES] } },
      client: { deceasedAt: null },
      OR: [
        { status: "WRITTEN_OFF", writeOffAt: { gte: reportingStart } },
        { status: { in: [...COLLECTIBLE_STATUSES] }, collectionsStage: "ATTORNEY_REFERRED" },
      ],
    },
    select: {
      id: true, reference: true, status: true, writeOffAt: true, collectionsStage: true,
      attorneyReferral: { select: { referralDate: true } },
      bureauAdverseConfirmations: { select: { statusCode: true } },
    },
    orderBy: { reference: "asc" },
  })
  return loans.flatMap((loan) => {
    const statusCode: AdverseStatus = loan.status === "WRITTEN_OFF" ? "W" : "L"
    if (loan.bureauAdverseConfirmations.some((c) => c.statusCode === statusCode)) return []
    return [{ loanId: loan.id, reference: loan.reference, statusCode, eventDay: adverseEventDay(loan, statusCode).eventDay }]
  })
}

export interface HeldRecord {
  loanId: string
  clientId: string
  reference: string
  reasons: string[]
  kind: "DAILY" | "MONTHLY"
  mode: "TEST" | "LIVE"
  dataFlag: string
  periodDay: string
}

/** How far back a held record is still worth showing. */
const HELD_WINDOW_DAYS = 62

/**
 * Records that are STILL held. A held line is dropped from the list once a
 * later file in the same mode SENT a line for that loan: a file of the same
 * kind, or, for a daily hold, the monthly file that registers the account.
 * Reads held rows, then sent rows for those loans only.
 */
export async function listHeldRecords(tenantId: string, now: Date): Promise<HeldRecord[]> {
  const since = { createdAt: { gte: new Date(now.getTime() - HELD_WINDOW_DAYS * 86_400_000) } }
  const rows = await prisma.bureauSubmissionRecord.findMany({
    where: { tenantId, heldReason: { not: null }, submission: since },
    select: {
      loanId: true, kind: true, mode: true, dataFlag: true, heldReason: true,
      submission: { select: { periodDate: true, createdAt: true } },
      loan: { select: { reference: true, clientId: true } },
    },
    orderBy: { submission: { createdAt: "desc" } },
  })
  if (rows.length === 0) return []
  const sent = await prisma.bureauSubmissionRecord.findMany({
    where: { tenantId, heldReason: null, loanId: { in: [...new Set(rows.map((row) => row.loanId))] }, submission: since },
    select: { loanId: true, mode: true, kind: true, submission: { select: { createdAt: true } } },
  })
  const lastSent = new Map<string, number>()
  for (const row of sent) {
    const key = `${row.loanId}|${row.mode}|${row.kind}`
    lastSent.set(key, Math.max(lastSent.get(key) ?? 0, row.submission.createdAt.getTime()))
  }
  // A later sent line clears a hold only if it is the same kind of file, or
  // the monthly file (which registers the account a daily file held). A daily
  // line never clears a monthly hold: that monthly line was still never sent.
  const clearedBy = (row: (typeof rows)[number]) => Math.max(
    lastSent.get(`${row.loanId}|${row.mode}|${row.kind}`) ?? 0,
    row.kind === "DAILY" ? lastSent.get(`${row.loanId}|${row.mode}|MONTHLY`) ?? 0 : 0,
  )

  const seen = new Set<string>()
  const held: HeldRecord[] = []
  for (const row of rows) {
    // Newest first: only the latest held line per loan, kind, mode and data flag.
    const key = `${row.loanId}|${row.kind}|${row.mode}|${row.dataFlag}`
    if (seen.has(key)) continue
    seen.add(key)
    if (clearedBy(row) > row.submission.createdAt.getTime()) continue
    held.push({
      loanId: row.loanId,
      clientId: row.loan.clientId,
      reference: row.loan.reference,
      reasons: (row.heldReason ?? "").split(","),
      kind: row.kind,
      mode: row.mode,
      dataFlag: row.dataFlag,
      periodDay: dbDateToDay(row.submission.periodDate),
    })
  }
  return held
}

export async function listSubmissions(tenantId: string) {
  const rows = await prisma.bureauSubmission.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true, kind: true, periodDate: true, mode: true, sequence: true, fileName: true, sha256: true,
      recordCount: true, heldCount: true, status: true, createdAt: true,
    },
  })
  // The same rule as render.ts isSuperseded: a TEST file is replaced by any
  // TEST file of its kind and period with a higher sequence.
  const key = (row: { kind: string; periodDate: Date }) => `${row.kind}|${row.periodDate.toISOString()}`
  const newestTest = new Map<string, number>()
  for (const row of rows) {
    if (row.mode === "TEST") newestTest.set(key(row), Math.max(newestTest.get(key(row)) ?? 0, row.sequence))
  }
  return rows.map((row) => ({
    ...row,
    superseded: row.mode === "TEST" && row.sequence < (newestTest.get(key(row)) ?? 0),
    periodDay: dbDateToDay(row.periodDate),
    createdAt: row.createdAt.toISOString(),
  }))
}

export type SubmissionRow = Awaited<ReturnType<typeof listSubmissions>>[number]

export async function bureauSetup(tenantId: string) {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { bureauSupplierNumber: true, bureauTradingName: true, bureauReportingStartDate: true },
  })
  return {
    mode: submissionMode(),
    supplierNumber: config?.bureauSupplierNumber ?? null,
    tradingName: config?.bureauTradingName ?? null,
    reportingStartDay: config?.bureauReportingStartDate ? dbDateToDay(config.bureauReportingStartDate) : null,
  }
}
