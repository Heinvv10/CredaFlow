/**
 * Reads a stored BANK_STATEMENT ClientDocument once per (bytes, parser
 * version) and persists the result as a StatementAnalysis row.
 *
 * Called on upload, on manual re-extract, and by the credit-check recompute
 * for any statement without a current read. Every query names the tenant
 * explicitly, because the upload path runs after its request has returned.
 */
import { Prisma, type StatementAnalysis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { analyseStatement, PARSER_VERSION, type StatementAnalysisResult } from "./analyse"
import { labelRead } from "./label-read"
import { VlmUnavailableError } from "./vlm-reader"

export interface EnsureOptions {
  tenantId: string
  documentId: string
  /**
   * False when a caller is waiting on the answer (the checks panel, the
   * approve route): a statement that would need the vision model is then
   * left unread rather than holding the request for minutes.
   */
  allowVlm: boolean
  /** Return a persisted read or pending; never run a reader (see load-facts LoadOptions). */
  persistedOnly?: boolean
  /**
   * With persistedOnly: the caller's transaction. A caller holding a row lock
   * must not wait on a second pool connection, or a full pool deadlocks.
   */
  db?: Pick<typeof prisma, "clientDocument" | "statementAnalysis">
  /** Re-extract: a stored READ_FAILED read is discarded and the file read again. */
  retryFailed?: boolean
  /** Who asked for the retry: named on the audit row of the discarded read. */
  actorUserId?: string
}

export type EnsureResult =
  | { state: "read"; analysis: StatementAnalysis }
  | { state: "pending"; reason: "vlm_deferred" | "vlm_unavailable" | "file_missing" | "reader_unavailable" }
  | { state: "missing" }

function toRow(tenantId: string, documentId: string, sha: string, r: StatementAnalysisResult) {
  return {
    tenantId,
    clientDocumentId: documentId,
    contentSha256: sha,
    parserVersion: PARSER_VERSION,
    method: r.method,
    status: r.status,
    bank: r.bank,
    accountHolderName: r.read?.accountHolderName ?? null,
    accountNumberLast4: r.read?.accountNumberLast4 ?? null,
    periodStart: r.read?.periodStart ? new Date(`${r.read.periodStart}T00:00:00Z`) : null,
    periodEnd: r.read?.periodEnd ? new Date(`${r.read.periodEnd}T00:00:00Z`) : null,
    openingBalanceCents: r.read?.openingBalanceCents ?? null,
    closingBalanceCents: r.read?.closingBalanceCents ?? null,
    transactions: (r.read?.transactions ?? []) as unknown as Prisma.InputJsonValue,
    balanceCheck: r.balanceCheck,
    balanceDiffCents: r.balanceDiffCents,
    authenticity: r.authenticity as unknown as Prisma.InputJsonValue,
  } satisfies Prisma.StatementAnalysisUncheckedCreateInput
}

/** A file the tools could not read at all is a result too: persisted, so it is not retried on every view. */
function readFailed(): StatementAnalysisResult {
  return {
    method: "TEXT", status: "UNREADABLE", bank: null, read: null, balanceCheck: "NOT_APPLICABLE", balanceDiffCents: null,
    authenticity: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["READ_FAILED"] },
  }
}

/**
 * Intake strips a statement's password with a full rewrite
 * (lib/documents/pdf-decrypt.ts), which erases any appended revisions. The
 * upload route records the original file's count on that audit row.
 */
async function revisionsBeforeDecryption(tenantId: string, documentId: string): Promise<number | null> {
  const row = await prisma.auditLog.findFirst({
    where: { tenantId, entity: "ClientDocument", entityId: documentId, action: AuditAction.DOCUMENT_DECRYPTED_AT_INTAKE },
    select: { newValue: true },
  })
  if (!row) return null
  const n = (row.newValue as { originalIncrementalUpdates?: unknown } | null)?.originalIncrementalUpdates
  return typeof n === "number" ? n : 0
}

function failedRead(a: StatementAnalysis): boolean {
  return a.status === "UNREADABLE" && ((a.authenticity as { signals?: unknown } | null)?.signals as string[] | undefined)?.includes("READ_FAILED") === true
}

/** Deleting a stored read is a state change: it is audited, with the read it removed. */
async function discardFailedRead(read: StatementAnalysis, opts: EnsureOptions): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.statementAnalysis.deleteMany({ where: { id: read.id, tenantId: opts.tenantId } })
    await logAuditStrict({
      tenantId: opts.tenantId,
      userId: opts.actorUserId,
      action: AuditAction.STATEMENT_READ_RETRIED,
      entity: "StatementAnalysis",
      entityId: read.id,
      oldValue: { documentId: read.clientDocumentId, status: read.status, contentSha256: read.contentSha256, parserVersion: read.parserVersion },
    }, tx)
  })
}

function findRead(tenantId: string, documentId: string, sha: string, db: Pick<typeof prisma, "statementAnalysis"> = prisma) {
  return db.statementAnalysis.findFirst({
    where: { tenantId, clientDocumentId: documentId, contentSha256: sha, parserVersion: PARSER_VERSION },
  })
}

/** The current read of a statement document, reading it first if needed. */
export async function ensureStatementAnalysis(opts: EnsureOptions): Promise<EnsureResult> {
  const db = opts.db ?? prisma
  const doc = await db.clientDocument.findFirst({
    where: { id: opts.documentId, tenantId: opts.tenantId, docType: "BANK_STATEMENT", deletedAt: null },
    select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
  })
  if (!doc?.storagePath) return { state: "missing" }

  const claimed = doc.contentSha256 ? await findRead(opts.tenantId, doc.id, doc.contentSha256, db) : null
  if (claimed && opts.retryFailed && failedRead(claimed)) {
    await discardFailedRead(claimed, opts)
  } else if (claimed) {
    return { state: "read", analysis: claimed }
  }
  if (opts.persistedOnly) {
    // A file whose bytes no longer match the row's hash was read under the
    // hash of its bytes: take the document's newest read either way.
    const latest = await db.statementAnalysis.findFirst({
      where: { tenantId: opts.tenantId, clientDocumentId: doc.id, parserVersion: PARSER_VERSION },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
    return latest ? { state: "read", analysis: latest } : { state: "pending", reason: "vlm_deferred" }
  }

  let bytes: Buffer
  try {
    bytes = await readFile(doc.storagePath)
  } catch {
    return { state: "pending", reason: "file_missing" }
  }
  // The read binds the bytes actually read, whatever the row claims.
  const sha = sha256DocumentBytes(bytes)
  const existing = sha !== doc.contentSha256 ? await findRead(opts.tenantId, doc.id, sha) : null
  if (existing && opts.retryFailed && failedRead(existing)) {
    await discardFailedRead(existing, opts)
  } else if (existing) {
    return { state: "read", analysis: existing }
  }
  const mimeType = doc.mimeType ?? "application/octet-stream"
  if (!opts.allowVlm && mimeType !== "application/pdf") return { state: "pending", reason: "vlm_deferred" }

  let analysed: StatementAnalysisResult
  try {
    analysed = await analyseStatement(bytes, mimeType, { allowVlm: opts.allowVlm })
  } catch (err) {
    if (err instanceof VlmUnavailableError) {
      if (opts.allowVlm) console.warn("[statement-analysis] vision reader unavailable:", { documentId: doc.id })
      return { state: "pending", reason: opts.allowVlm ? "vlm_unavailable" : "vlm_deferred" }
    }
    // The tools themselves missing (exit 126/127, spawn ENOENT) says nothing about
    // the file: report it, store nothing, and read again once they are back.
    const code = (err as { code?: unknown }).code
    if (code === 126 || code === 127 || code === "ENOENT") {
      console.error("[statement-analysis] PDF tools unavailable:", { documentId: doc.id, code })
      return { state: "pending", reason: "reader_unavailable" }
    }
    console.warn("[statement-analysis] statement could not be read:", { documentId: doc.id, error: err instanceof Error ? err.name : "unknown" })
    analysed = readFailed()
  }
  const before = await revisionsBeforeDecryption(opts.tenantId, doc.id)
  if (before !== null) {
    analysed.authenticity.incrementalUpdates = Math.max(analysed.authenticity.incrementalUpdates, before)
    analysed.authenticity.signals.push("DECRYPTED_AT_INTAKE")
  }
  try {
    const analysis = await prisma.statementAnalysis.create({ data: toRow(opts.tenantId, doc.id, sha, analysed) })
    return { state: "read", analysis }
  } catch (err) {
    // A concurrent read of the same bytes won the unique key; use its row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await findRead(opts.tenantId, doc.id, sha)
      if (winner) return { state: "read", analysis: winner }
    }
    throw err
  }
}

// One background read at a time per process: each may make a dozen calls to
// the shared vision model. A document already queued is not queued twice.
let queue: Promise<unknown> = Promise.resolve()

interface ReadRequest {
  retryFailed?: boolean
  actorUserId?: string
  onRead?: () => Promise<unknown>
  /** Runs only when model labels were stored by this run (a read already labelled, or a model down, runs nothing). */
  onLabelled?: () => Promise<unknown>
}

/**
 * Requests per document, merged: a retry or a callback asked for while the
 * document already waits rides on that run, and one asked for while it is
 * being read runs once that read is done. Callbacks run only after a read is
 * stored; a read left pending is re-queued when its application is next loaded.
 */
const waiting = new Map<string, { tenantId: string; retry?: string | null; onReads: Array<() => Promise<unknown>>; onLabelled: Array<() => Promise<unknown>> }>()
const running = new Set<string>()

/**
 * Reads one tenant may have waiting. The queue is shared by every tenant on
 * the process, so one uploading hundreds of statements would otherwise hold
 * the vision model for hours. A document turned away stays unread and is
 * queued again when its application is next loaded.
 */
export const MAX_WAITING_PER_TENANT = 20

function merge(tenantId: string, documentId: string, opts: ReadRequest): void {
  const w = waiting.get(documentId) ?? { tenantId, onReads: [], onLabelled: [] }
  if (opts.retryFailed) w.retry = opts.actorUserId ?? null
  if (opts.onRead) w.onReads.push(opts.onRead)
  if (opts.onLabelled) w.onLabelled.push(opts.onLabelled)
  waiting.set(documentId, w)
}

/**
 * Fire-and-forget read for the upload and re-extract paths. `onRead` runs
 * after a read is stored, so the caller can raise its findings at once rather
 * than when someone next opens the application.
 */
export function readStatementInBackground(tenantId: string, documentId: string, opts: ReadRequest = {}): void {
  const alreadyWaiting = waiting.has(documentId)
  // A staff retry gets headroom past the cap, since a stored failed read is
  // not re-queued on load; the headroom is bounded too, so retries cannot
  // become a way round it.
  const queued = [...waiting.values()].filter((w) => w.tenantId === tenantId).length
  const cap = opts.retryFailed ? 2 * MAX_WAITING_PER_TENANT : MAX_WAITING_PER_TENANT
  if (!alreadyWaiting && queued >= cap) {
    console.warn("[statement-analysis] read not queued: tenant queue full", { documentId })
    return
  }
  merge(tenantId, documentId, opts)
  if (alreadyWaiting || running.has(documentId)) return
  schedule(documentId)
}

function schedule(documentId: string): void {
  queue = queue
    .then(async () => {
      const w = waiting.get(documentId)
      if (!w) return
      waiting.delete(documentId)
      running.add(documentId)
      const r = await ensureStatementAnalysis({
        tenantId: w.tenantId, documentId, allowVlm: true,
        retryFailed: w.retry !== undefined, actorUserId: w.retry ?? undefined,
      })
      if (r.state !== "read") return
      // Labelled before the callbacks run, so the checks they recompute see the labels.
      const labelled = await labelRead(w.tenantId, r.analysis)
      // Each callback on its own: one failing must not skip the others, nor be
      // reported as a failed read.
      for (const onRead of [...w.onReads, ...(labelled ? w.onLabelled : [])]) {
        try {
          await onRead()
        } catch (err) {
          console.error("[statement-analysis] after-read callback failed:", { documentId, error: err instanceof Error ? err.name : "unknown" })
        }
      }
    })
    .catch((err) => {
      // Name and code only: a failed write can echo the statement's contents.
      console.error("[statement-analysis] read failed:", { documentId, error: err instanceof Error ? err.name : "unknown", code: (err as { code?: unknown })?.code })
    })
    .finally(() => {
      running.delete(documentId)
      // Asked for while it was being read: read again now.
      if (waiting.has(documentId)) schedule(documentId)
    })
}
