import { createHash } from "node:crypto"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { deleteFile, readFile, saveFile } from "@/lib/storage"
import { renderPostSaleStatement } from "./documents/post-sale-statement"
import { renderRecoveryFinalNotice, renderRecoveryValuationNotice } from "./documents/nca/recovery-pdf"
import { dbDate, isoOfDbDate } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { loadRecoveryNoticeData } from "./recovery-notice-data"
import { recoveryChargeFreeze } from "./recovery-deadline"
import type { SigningTx } from "./signing-prepare"
import { advance, RecoveryRefusal, refusable, type RecoveryResult } from "./recovery-result"
import { issueSurrenderNotice, readSurrenderNotice } from "./surrender-store"

export type RecoveryDocumentKind = "valuation" | "final" | "statement"

const NOT_NCA = "A NON_NCA recovery has no NCA notice; its post-sale account statement is the statement document"

/**
 * VALUED → VALUATION_NOTICE_ISSUED. s127: the surrender's own notice (issued
 * through the surrender route) must already exist; s131: rendered and stored
 * here. NON_NCA has none. UNTESTED: legal sign-off on the notice wording.
 */
export async function issueRecoveryValuationNotice(actor: RecoveryActor, id: string): Promise<RecoveryResult> {
  const loaded = await loadRecoveryNoticeData(actor.tenantId, id, new Date())
  if (!loaded) return { kind: "not_found" }
  const { row, data } = loaded
  if (row.route === "NON_NCA_VOLUNTARY" || row.route === "NON_NCA_COURT_ORDER") return { kind: "not_ready", reason: NOT_NCA }
  if (row.status !== "VALUED") return { kind: "not_ready", reason: "The recovery is not ready for its valuation notice" }
  if (row.surrenderRequestId) {
    return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
      const surrender = await tx.surrenderRequest.findFirst({ where: { id: row.surrenderRequestId ?? "", tenantId: actor.tenantId }, select: { status: true } })
      if (surrender?.status !== "VALUATION_NOTICE_ISSUED") throw new RecoveryRefusal("Issue the surrender's valuation notice first: an s127 recovery follows it")
      await advance(tx, actor, id, "VALUED", { status: "VALUATION_NOTICE_ISSUED" })
      await auditNotice(tx, actor, id, AuditAction.ASSET_RECOVERY_VALUATION_NOTICE_ISSUED, { surrenderRequestId: row.surrenderRequestId })
      return { kind: "done", id }
    }))
  }
  const bytes = await renderRecoveryValuationNotice(data)
  return storeAndAdvance(actor, id, bytes, "VALUED", (stored, sha256) => ({ status: "VALUATION_NOTICE_ISSUED", valuationNoticePath: stored, valuationNoticeSha256: sha256 }),
    AuditAction.ASSET_RECOVERY_VALUATION_NOTICE_ISSUED)
}

/**
 * PROCEEDS_APPLIED → FINAL_NOTICE_ISSUED, setting the final notice date and the
 * end of the charge freeze (10 SA business days later). s127 issues the
 * surrender's final notice (with the recovery's cost table); s131 renders its
 * own. NON_NCA has no NCA notice. UNTESTED: legal sign-off on the notice and the freeze.
 */
export async function issueRecoveryFinalNotice(actor: RecoveryActor, id: string): Promise<RecoveryResult> {
  const loaded = await loadRecoveryNoticeData(actor.tenantId, id, new Date())
  if (!loaded) return { kind: "not_found" }
  const { row, data } = loaded
  if (row.route === "NON_NCA_VOLUNTARY" || row.route === "NON_NCA_COURT_ORDER") return { kind: "not_ready", reason: NOT_NCA }
  if (row.status !== "PROCEEDS_APPLIED" || !row.chargesFrozenFrom) return { kind: "not_ready", reason: "Apply the sale proceeds before the final notice" }
  const finalNoticeIssuedOn = sastCalendarDate(new Date())
  const { frozenUntil } = recoveryChargeFreeze({ regime: "NCA", proceedsAppliedOn: isoOfDbDate(row.chargesFrozenFrom), finalNoticeIssuedOn, nonNcaDemandPeriodDays: 0 })
  const step = { status: "FINAL_NOTICE_ISSUED" as const, finalNoticeIssuedOn: dbDate(finalNoticeIssuedOn), chargesFrozenUntil: dbDate(frozenUntil) }
  const audit = { finalNoticeIssuedOn, chargesFrozenUntil: frozenUntil }
  if (row.surrenderRequestId) {
    const surrender = await prisma.surrenderRequest.findFirst({ where: { id: row.surrenderRequestId, tenantId: actor.tenantId }, select: { status: true } })
    if (surrender?.status === "PROCEEDS_CREDITED") {
      const issued = await issueSurrenderNotice(actor, row.surrenderRequestId, "final")
      if (issued.kind !== "done") return issued
    } else if (surrender?.status !== "FINAL_NOTICE_ISSUED") {
      return { kind: "not_ready", reason: "The surrender's sale proceeds are not credited yet" }
    }
    return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
      await advance(tx, actor, id, "PROCEEDS_APPLIED", step)
      await auditNotice(tx, actor, id, AuditAction.ASSET_RECOVERY_FINAL_NOTICE_ISSUED, { ...audit, surrenderRequestId: row.surrenderRequestId })
      return { kind: "done", id }
    }))
  }
  const bytes = await renderRecoveryFinalNotice(data)
  return storeAndAdvance(actor, id, bytes, "PROCEEDS_APPLIED", (stored, sha256) => ({ ...step, finalNoticePath: stored, finalNoticeSha256: sha256 }),
    AuditAction.ASSET_RECOVERY_FINAL_NOTICE_ISSUED, audit)
}

/**
 * A recovery document's bytes: the s127 notices are the surrender's, the s131
 * ones are stored on the recovery (both checked against their digest), and a
 * NON_NCA recovery's post-sale statement is rendered on demand.
 */
export async function readRecoveryDocument(tenantId: string, id: string, kind: RecoveryDocumentKind): Promise<{ bytes: Buffer; sha256: string } | null> {
  const row = await prisma.recovery.findFirst({ where: { id, tenantId }, select: {
    route: true, surrenderRequestId: true, valuationNoticePath: true, valuationNoticeSha256: true, finalNoticePath: true, finalNoticeSha256: true,
  } })
  if (!row) return null
  const nonNca = row.route === "NON_NCA_VOLUNTARY" || row.route === "NON_NCA_COURT_ORDER"
  if (kind === "statement") {
    if (!nonNca) return null
    const loaded = await loadRecoveryNoticeData(tenantId, id, new Date())
    if (!loaded?.data.outcome) return null
    const bytes = await renderPostSaleStatement(loaded.data)
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  if (nonNca) return null
  if (row.surrenderRequestId) return readSurrenderNotice(tenantId, row.surrenderRequestId, kind)
  const path = kind === "valuation" ? row.valuationNoticePath : row.finalNoticePath
  const sha256 = kind === "valuation" ? row.valuationNoticeSha256 : row.finalNoticeSha256
  if (!path || !sha256) return null
  const bytes = await readFile(path)
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Recovery notice bytes failed integrity check")
  return { bytes, sha256 }
}

async function auditNotice(tx: SigningTx, actor: RecoveryActor, id: string, action: string, newValue: Record<string, unknown>): Promise<void> {
  await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
    action, entity: "Recovery", entityId: id, newValue: { ...newValue, draftLegalWording: true },
  }, tx)
}

/** Saves the rendered notice, then moves the recovery on in one transaction; a refused step deletes the file. */
async function storeAndAdvance(
  actor: RecoveryActor, id: string, bytes: Buffer, from: "VALUED" | "PROCEEDS_APPLIED",
  data: (storagePath: string, sha256: string) => Parameters<typeof advance>[4], action: string, extra: Record<string, unknown> = {},
): Promise<RecoveryResult> {
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const stored = await saveFile(bytes, "application/pdf")
  try {
    const outcome = await refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
      await advance(tx, actor, id, from, data(stored.storagePath, sha256))
      await auditNotice(tx, actor, id, action, { ...extra, sha256, storagePath: stored.storagePath })
      return { kind: "done", id }
    }))
    if (outcome.kind !== "done") await deleteFile(stored.storagePath)
    return outcome
  } catch (error) {
    await deleteFile(stored.storagePath)
    throw error
  }
}
