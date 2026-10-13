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
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { analyseStatement, PARSER_VERSION } from "./analyse"
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
}

export type EnsureResult =
  | { state: "read"; analysis: StatementAnalysis }
  | { state: "pending"; reason: "vlm_deferred" | "vlm_unavailable" }
  | { state: "missing" }

function toRow(tenantId: string, documentId: string, sha: string, r: Awaited<ReturnType<typeof analyseStatement>>) {
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

/** The current read of a statement document, reading it first if needed. */
export async function ensureStatementAnalysis(opts: EnsureOptions): Promise<EnsureResult> {
  const doc = await prisma.clientDocument.findFirst({
    where: { id: opts.documentId, tenantId: opts.tenantId, docType: "BANK_STATEMENT", deletedAt: null },
    select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
  })
  if (!doc?.storagePath) return { state: "missing" }

  const existing = doc.contentSha256
    ? await prisma.statementAnalysis.findFirst({
        where: { tenantId: opts.tenantId, clientDocumentId: doc.id, contentSha256: doc.contentSha256, parserVersion: PARSER_VERSION },
      })
    : null
  if (existing) return { state: "read", analysis: existing }

  const bytes = await readFile(doc.storagePath)
  // The read binds the bytes actually read, whatever the row claims.
  const sha = sha256DocumentBytes(bytes)
  const mimeType = doc.mimeType ?? "application/octet-stream"
  if (!opts.allowVlm && mimeType !== "application/pdf") return { state: "pending", reason: "vlm_deferred" }

  let analysed: Awaited<ReturnType<typeof analyseStatement>>
  try {
    analysed = await analyseStatement(bytes, mimeType, { allowVlm: opts.allowVlm })
  } catch (err) {
    if (err instanceof VlmUnavailableError) {
      if (opts.allowVlm) console.warn("[statement-analysis] vision reader unavailable:", err.message)
      return { state: "pending", reason: opts.allowVlm ? "vlm_unavailable" : "vlm_deferred" }
    }
    throw err
  }
  try {
    const analysis = await prisma.statementAnalysis.create({ data: toRow(opts.tenantId, doc.id, sha, analysed) })
    return { state: "read", analysis }
  } catch (err) {
    // A concurrent read of the same bytes won the unique key; use its row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.statementAnalysis.findFirst({
        where: { tenantId: opts.tenantId, clientDocumentId: doc.id, contentSha256: sha, parserVersion: PARSER_VERSION },
      })
      if (winner) return { state: "read", analysis: winner }
    }
    throw err
  }
}

/** Fire-and-forget read for the upload and re-extract paths. */
export function readStatementInBackground(tenantId: string, documentId: string): void {
  void ensureStatementAnalysis({ tenantId, documentId, allowVlm: true }).catch((err) => {
    console.error("[statement-analysis] read failed:", { documentId }, err)
  })
}
