import { createHash } from "node:crypto"
import type { prisma } from "@/lib/prisma"
import {
  renderFile,
  renderHeader,
  renderRecord,
  renderTrailer,
  type FieldValues,
  type SubmissionKind,
} from "./layout"

// A file's bytes, built from field values. Used once at generation and again
// on every download — the second time from the ledger snapshot alone, never
// from live loan columns.

export interface HeaderValues {
  supplierNumber: string
  monthEndDate: string
  creationDate: string
  tradingName: string
}

/** Lines of the file, CRLF excluded. A monthly file is wrapped in header and trailer. */
export function assembleLines(kind: SubmissionKind, records: FieldValues[], header: HeaderValues | null): string[] {
  const lines = records.map((fields) => renderRecord(fields, kind))
  if (kind === "DAILY") return lines
  if (!header) throw new Error("A monthly bureau file needs a header")
  return [renderHeader(header), ...lines, renderTrailer(lines.length + 2)]
}

/** The file is ASCII (spec p22), so latin1 is one byte per character. */
export function sha256Of(content: string): string {
  return createHash("sha256").update(content, "latin1").digest("hex")
}

type Db = Pick<typeof prisma, "bureauSubmission" | "bureauSubmissionRecord">

/** A TEST file is superseded once a later TEST file exists for its kind and period. */
export async function isSuperseded(db: Db, submission: { tenantId: string; kind: SubmissionKind; mode: string; periodDate: Date; sequence: number }): Promise<boolean> {
  if (submission.mode !== "TEST") return false
  const newer = await db.bureauSubmission.findFirst({
    where: { tenantId: submission.tenantId, kind: submission.kind, mode: "TEST", periodDate: submission.periodDate, sequence: { gt: submission.sequence } },
    select: { id: true },
  })
  return newer !== null
}

export interface RenderedSubmission {
  id: string
  fileName: string
  content: string
  /** the re-rendered bytes hash to what the ledger stored at generation */
  intact: boolean
  /** a TEST file whose lines were dropped when a newer TEST file replaced it */
  superseded: boolean
  recordCount: number
}

/** Re-render a submission from its ledger rows. Null when it is not this tenant's. */
export async function renderSubmission(db: Db, tenantId: string, submissionId: string): Promise<RenderedSubmission | null> {
  const submission = await db.bureauSubmission.findFirst({ where: { id: submissionId, tenantId } })
  if (!submission) return null
  const records = await db.bureauSubmissionRecord.findMany({
    where: { tenantId, submissionId: submission.id, heldReason: null },
    orderBy: { lineNo: "asc" },
    select: { fields: true },
  })
  const content = renderFile(assembleLines(
    submission.kind,
    records.map((record) => record.fields as FieldValues),
    submission.header as HeaderValues | null,
  ))
  return {
    id: submission.id,
    fileName: submission.fileName,
    content,
    intact: sha256Of(content) === submission.sha256,
    superseded: await isSuperseded(db, submission),
    recordCount: records.length,
  }
}
