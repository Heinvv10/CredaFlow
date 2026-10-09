import { createHash } from "crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { saveFile } from "@/lib/storage"
import { logAudit, AuditAction } from "@/lib/audit"
import { parseStatementCsv } from "./parse"
import { matchTransactions } from "./reconcile"
import { persistTransactions } from "./ingest"
import { buildCandidateLoans } from "./candidates"
import { applyBankTransaction } from "./apply"

/** Max accepted statement size. Mirrors the route's original limit. */
export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024

/** Tenant has no `bankSyncEnabled` — caller maps to 403 / a UI error. */
export class BankSyncDisabledError extends Error {}

/** Malformed CSV. Thrown BEFORE anything is persisted — caller maps to 422. */
export class StatementParseError extends Error {}

/**
 * Audit actor for an AUTO-APPLIED match — always the machine, never the person
 * who uploaded the file.
 *
 * Auto-apply books a Payment off the matcher's own HIGH confidence; no human
 * looked at it. Stamping the uploader's email on that reconcile audit would
 * claim they reviewed a match they never saw, and make it near-indistinguishable
 * from a real confirmMatchAction. `actorEmail` answers "who loaded the
 * statement"; this answers "who reconciled this line", and for auto-apply the
 * honest answer is the system.
 */
const AUTO_APPLY_ACTOR = "system@bank-sync"

export interface ImportStatementInput {
  tenantId: string
  /** Decoded CSV text. The caller owns decoding + the size check. */
  raw: string
  contentType: string
  accountRef: string
  format: string
  periodStart: Date | null
  periodEnd: Date | null
  /**
   * Who to attribute THE IMPORT to in the audit log. The worker passes
   * "system@bank-sync"; a staff upload passes the real user's email. This is a
   * POPIA/NCA audit obligation, not a nicety — an auditor asking "who loaded
   * this statement" must get a person, not a service account, when it was a
   * person.
   *
   * SCOPE: the import event ONLY. It is deliberately NOT threaded into
   * auto-apply's per-transaction reconcile audit — see AUTO_APPLY_ACTOR.
   */
  actorEmail: string
}

export interface ImportStatementResult {
  importId: string
  lineCount: number
  newTxnCount: number
  autoApplied: number
  /** True when this exact file (by sha256) was already imported for the tenant. */
  deduplicated: boolean
}

/**
 * Ingest an already-downloaded ABSA statement: dedup-by-fileHash (idempotent)
 * -> parse (fails closed before any persistence) -> save raw file -> create
 * import row -> build candidate loans -> match -> persist (dedup per line) ->
 * optional auto-apply of HIGH-confidence matches -> finalize + audit.
 *
 * Source-agnostic BY DESIGN: it takes bytes, not a bank session. The staff
 * manual upload calls this, and any future source must too, so the money path
 * exists exactly once. Callers own authentication and HTTP/UI error mapping;
 * this owns the pipeline.
 */
export async function importStatement(input: ImportStatementInput): Promise<ImportStatementResult> {
  const { tenantId, raw, contentType, accountRef, format, periodStart, periodEnd, actorEmail } = input

  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } })
  if (!config?.bankSyncEnabled) {
    throw new BankSyncDisabledError("Bank sync not enabled for tenant")
  }

  const fileHash = createHash("sha256").update(raw).digest("hex")

  const prior = await prisma.bankStatementImport.findUnique({
    where: { tenantId_fileHash: { tenantId, fileHash } },
  })
  if (prior) {
    return {
      importId: prior.id,
      lineCount: prior.lineCount,
      newTxnCount: prior.newTxnCount,
      autoApplied: 0,
      deduplicated: true,
    }
  }

  // Parse first so a malformed file fails before we persist anything.
  let lines
  try {
    lines = parseStatementCsv(raw)
  } catch (e) {
    throw new StatementParseError(`Parse failed: ${(e as Error).message}`)
  }

  const { storagePath } = await saveFile(Buffer.from(raw), contentType || "text/csv")

  // Concurrent double-submit of the same file races past the prior-check above
  // and only collides at the DB's (tenantId, fileHash) unique index — treat
  // that as the same idempotent duplicate rather than a 500.
  let imp
  try {
    imp = await prisma.bankStatementImport.create({
      data: {
        tenantId,
        source: "ABSA_ONLINE",
        accountRef,
        format,
        periodStart,
        periodEnd,
        fileHash,
        rawFilePath: storagePath,
        lineCount: lines.length,
        status: "PARSED",
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const dup = await prisma.bankStatementImport.findUnique({
        where: { tenantId_fileHash: { tenantId, fileHash } },
      })
      if (dup) {
        return {
          importId: dup.id,
          lineCount: dup.lineCount,
          newTxnCount: dup.newTxnCount,
          autoApplied: 0,
          deduplicated: true,
        }
      }
    }
    throw e
  }

  const candidates = await buildCandidateLoans(tenantId)
  const results = matchTransactions(lines, candidates)
  const { newTxnCount, created } = await persistTransactions({ tenantId, importId: imp.id, results })

  let autoApplied = 0
  if (config.absaAutoApplyHighConfidence) {
    for (const c of created) {
      if (c.confidence !== "HIGH" || !c.matchedLoanId) continue
      try {
        await applyBankTransaction({ txnId: c.id, loanId: c.matchedLoanId, tenantId, userEmail: AUTO_APPLY_ACTOR })
        autoApplied++
      } catch (e) {
        // Auto-apply is best-effort; on a per-row guard failure (e.g. loan not
        // ACTIVE, over-collection, concurrent claim lost) leave the row PROPOSED
        // for human review. Log it so a systemic failure is diagnosable rather
        // than silently swallowed.
        console.error(`[bank-sync] auto-apply failed for txn ${c.id} (loan ${c.matchedLoanId}):`, e)
      }
    }
  }

  await prisma.bankStatementImport.update({
    where: { id: imp.id, tenantId },
    data: { newTxnCount, status: "RECONCILED", finishedAt: new Date() },
  })

  await logAudit({
    tenantId,
    userEmail: actorEmail,
    action: AuditAction.BANK_STATEMENT_IMPORTED,
    entity: "BankStatementImport",
    entityId: imp.id,
    newValue: { lineCount: lines.length, newTxnCount, autoApplied },
  })

  return { importId: imp.id, lineCount: lines.length, newTxnCount, autoApplied, deduplicated: false }
}
