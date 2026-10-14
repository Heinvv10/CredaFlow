import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { NotificationType } from "@/lib/notifications/bell"
import { bureauFileName, parseRecord, renderFile, type FieldValues, type SubmissionKind, type SubmissionMode } from "./layout"
import { compact, dayEnd, dayOf, dayToDbDate, dbDateToDay, isMonthEnd, type Day } from "./period"
import { prepareDaily, prepareMonthly, type PrepareDb, type Prepared } from "./prepare"
import { pushSubmission, type PushOutcome } from "./push"
import { assembleLines, sha256Of, type HeaderValues } from "./render"
import { cleanAddressLine } from "./clean"
import { BureauError, BureauFileError, validateFile } from "./validate"

// prepare (read-only) -> render -> ledger, in one transaction. Nothing is
// written to disk: the ledger rows ARE the file.

type Db = Pick<typeof prisma, "$transaction" | "tenantConfig" | "bureauSubmission"> & PrepareDb

export interface Actor {
  source: "cron" | "staff"
  userId?: string
  userEmail?: string
}

export type GenerateResult =
  | { outcome: "DISABLED" | "NOT_CONFIGURED" | "BEFORE_REPORTING_START" | "NOTHING_TO_SEND" }
  | {
      outcome: "GENERATED"
      submissionId: string
      fileName: string
      sha256: string
      recordCount: number
      heldCount: number
      heldByReason: Record<string, number>
      push: PushOutcome
    }

/** TEST unless the environment says LIVE in so many words. */
export function submissionMode(): SubmissionMode {
  return process.env.BUREAU_SUBMISSION_MODE === "LIVE" ? "LIVE" : "TEST"
}

async function bureauConfig(db: Db, tenantId: string) {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { featureBureauSubmission: true, bureauSupplierNumber: true, bureauTradingName: true, bureauReportingStartDate: true },
  })
  if (!config?.featureBureauSubmission) return "DISABLED" as const
  // Both go into the header line and the file name, so neither is taken as
  // typed: a supplier number is SACRRA's short alphanumeric code, and the
  // trading name is cleaned like any other free text in the file.
  const supplierNumber = config.bureauSupplierNumber?.trim().toUpperCase() ?? ""
  const tradingName = cleanAddressLine(config.bureauTradingName)
  if (!SUPPLIER_NUMBER.test(supplierNumber) || !tradingName || !config.bureauReportingStartDate) return "NOT_CONFIGURED" as const
  return { supplierNumber, tradingName, reportingStartDay: dbDateToDay(config.bureauReportingStartDate) }
}

/** SACRRA supplier reference: up to 10 letters and digits (spec p22). */
export const SUPPLIER_NUMBER = /^[A-Z0-9]{1,10}$/

/** Staff with a role that can act on a held record, told through the bell. */
const ALERTED_ROLES = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] as const

async function writeLedger(db: Db, args: {
  tenantId: string
  kind: SubmissionKind
  mode: SubmissionMode
  day: Day
  supplierNumber: string
  header: HeaderValues | null
  prepared: Prepared[]
  /** the highest sequence that existed BEFORE the book was read */
  sequenceBefore: number
  actor: Actor
}): Promise<GenerateResult> {
  const sent = args.prepared.filter((p) => p.held.length === 0)
  const held = args.prepared.filter((p) => p.held.length > 0)
  const lines = assembleLines(args.kind, sent.map((p) => p.mapped.fields), args.header)
  const errors = validateFile(args.kind, lines, args.supplierNumber)
  if (errors.length > 0) throw new BureauFileError(errors)
  const content = renderFile(lines)
  const sha256 = sha256Of(content)
  const recordLines = args.kind === "MONTHLY" ? lines.slice(1, -1) : lines
  const heldByReason: Record<string, number> = {}
  for (const reason of held.flatMap((p) => p.held)) heldByReason[reason] = (heldByReason[reason] ?? 0) + 1
  const periodDate = dayToDbDate(args.day)

  const row = (p: Prepared, lineNo: number | null, fields: FieldValues): Prisma.BureauSubmissionRecordCreateManyInput => ({
    tenantId: args.tenantId,
    submissionId: "",
    kind: args.kind,
    mode: args.mode,
    loanId: p.loanId,
    lineNo,
    dataFlag: p.dataFlag,
    statusCode: p.mapped.statusCode,
    statusDate: p.mapped.statusDate ? dayToDbDate(dayOf(p.mapped.statusDate)) : null,
    fields,
    heldReason: p.held.length > 0 ? p.held.join(",") : null,
  })

  const scope = { tenantId: args.tenantId, kind: args.kind, periodDate, mode: args.mode }
  const submission = await db.$transaction(async (tx) => {
    // One writer per tenant and kind at a time. The book was read before this
    // transaction, so a run that finished in between has already sent what
    // this one is about to send: refuse rather than send it twice.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bureau:${args.tenantId}:${args.kind}`}, 0))`)
    const last = await tx.bureauSubmission.aggregate({ where: scope, _max: { sequence: true } })
    if ((last._max.sequence ?? 0) !== args.sequenceBefore) {
      throw new BureauError(`Another bureau ${args.kind.toLowerCase()} file for ${args.day} was generated at the same time. Run it again.`)
    }
    const sequence = args.sequenceBefore + 1
    // The hub's sequence component is two digits (spec p20).
    if (sequence > 99) throw new BureauError("Bureau submission sequence exhausted for this period")
    // A TEST file is for review and is superseded by the next one. Its lines
    // are a full copy of every client's personal data, so they are not kept.
    if (args.mode === "TEST") {
      await tx.bureauSubmissionRecord.deleteMany({ where: { tenantId: args.tenantId, kind: args.kind, mode: "TEST", submission: { periodDate } } })
    }
    const created = await tx.bureauSubmission.create({
      data: {
        tenantId: args.tenantId,
        kind: args.kind,
        periodDate,
        mode: args.mode,
        sequence,
        fileName: bureauFileName({ supplierNumber: args.supplierNumber, mode: args.mode, kind: args.kind, date: compact(args.day), sequence }),
        sha256,
        recordCount: sent.length,
        heldCount: held.length,
        header: args.header ? { ...args.header } : undefined,
      },
    })
    await tx.bureauSubmissionRecord.createMany({
      data: [
        // The snapshot is the line as rendered, so a re-render is byte-identical.
        ...sent.map((p, i) => row(p, i + 1, parseRecord(recordLines[i], args.kind))),
        ...held.map((p) => row(p, null, p.mapped.fields)),
      ].map((data) => ({ ...data, submissionId: created.id })),
    })
    // Counts and identifiers only: never a name, an ID number or a line.
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.userId,
      userEmail: args.actor.userEmail,
      action: AuditAction.BUREAU_SUBMISSION_GENERATED,
      entity: "BureauSubmission",
      entityId: created.id,
      newValue: {
        kind: args.kind, mode: args.mode, period: args.day, sequence, fileName: created.fileName,
        sha256, recordCount: sent.length, heldCount: held.length, heldByReason, source: args.actor.source,
      },
    }, tx)
    if (held.length > 0 && args.actor.source === "cron") {
      const staff = await tx.user.findMany({
        where: { tenantId: args.tenantId, active: true, role: { in: [...ALERTED_ROLES] } },
        select: { id: true },
      })
      await tx.notification.createMany({
        data: staff.map((user) => ({
          tenantId: args.tenantId,
          userId: user.id,
          type: "BUREAU_HELD" satisfies NotificationType,
          title: `${held.length} record(s) held back from the bureau file`,
          body: `The ${args.kind.toLowerCase()} bureau file for ${args.day} left out ${held.length} record(s) that failed validation. They are not reported until fixed.`,
          entityType: "BureauSubmission",
          entityId: created.id,
        })),
      })
    }
    return created
  })

  return {
    outcome: "GENERATED",
    submissionId: submission.id,
    fileName: submission.fileName,
    sha256,
    recordCount: sent.length,
    heldCount: held.length,
    heldByReason,
    push: await pushSubmission(db, { tenantId: args.tenantId, submissionId: submission.id, mode: args.mode }),
  }
}

function assertEnded(day: Day, now: Date) {
  if (dayEnd(day) > now) throw new BureauError(`Bureau period ${day} has not ended`)
}

/** Read BEFORE the book, so writeLedger can tell whether another run got in between. */
async function sequenceBefore(db: Db, args: { tenantId: string; kind: SubmissionKind; day: Day; mode: SubmissionMode }): Promise<number> {
  const last = await db.bureauSubmission.aggregate({
    where: { tenantId: args.tenantId, kind: args.kind, periodDate: dayToDbDate(args.day), mode: args.mode },
    _max: { sequence: true },
  })
  return last._max.sequence ?? 0
}

export async function generateMonthly(db: Db, args: {
  tenantId: string
  periodDay: Day
  mode: SubmissionMode
  now: Date
  actor: Actor
}): Promise<GenerateResult> {
  if (!isMonthEnd(args.periodDay)) throw new BureauError(`Bureau monthly period ${args.periodDay} is not a month end`)
  assertEnded(args.periodDay, args.now)
  const config = await bureauConfig(db, args.tenantId)
  if (typeof config === "string") return { outcome: config }
  if (args.periodDay < config.reportingStartDay) return { outcome: "BEFORE_REPORTING_START" }
  const before = await sequenceBefore(db, { tenantId: args.tenantId, kind: "MONTHLY", day: args.periodDay, mode: args.mode })

  return writeLedger(db, {
    tenantId: args.tenantId,
    kind: "MONTHLY",
    mode: args.mode,
    day: args.periodDay,
    supplierNumber: config.supplierNumber,
    header: {
      supplierNumber: config.supplierNumber,
      monthEndDate: compact(args.periodDay),
      creationDate: compact(dayOf(args.now)),
      tradingName: config.tradingName,
    },
    prepared: await prepareMonthly(db, { tenantId: args.tenantId, day: args.periodDay, ...config }),
    sequenceBefore: before,
    actor: args.actor,
  })
}

export async function generateDaily(db: Db, args: {
  tenantId: string
  day: Day
  mode: SubmissionMode
  now: Date
  actor: Actor
}): Promise<GenerateResult> {
  assertEnded(args.day, args.now)
  const config = await bureauConfig(db, args.tenantId)
  if (typeof config === "string") return { outcome: config }

  const before = await sequenceBefore(db, { tenantId: args.tenantId, kind: "DAILY", day: args.day, mode: args.mode })
  const prepared = await prepareDaily(db, { tenantId: args.tenantId, day: args.day, ...config })
  // No file and no ledger row on a day with nothing to send or to hold.
  if (prepared.length === 0) return { outcome: "NOTHING_TO_SEND" }

  return writeLedger(db, {
    tenantId: args.tenantId,
    kind: "DAILY",
    mode: args.mode,
    day: args.day,
    supplierNumber: config.supplierNumber,
    header: null,
    prepared,
    sequenceBefore: before,
    actor: args.actor,
  })
}
