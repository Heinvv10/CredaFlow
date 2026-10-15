/**
 * Route callers and cleanup for the slice 4a legal matter suite
 * (RUN_ASSET_FINANCE_RECOVERY_IT). Everything else comes from
 * recovery.integration-fixture.ts. Every value is synthetic. Not a test file.
 */
import { unlink } from "node:fs/promises"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { POST as openRoute, GET as loanViewRoute } from "@/app/api/asset-finance/loans/[loanId]/legal-matter/route"
import { GET as matterRoute } from "@/app/api/asset-finance/legal-matters/[id]/route"
import { POST as attorneyRoute } from "@/app/api/asset-finance/legal-matters/[id]/attorney/route"
import { POST as stepRoute } from "@/app/api/asset-finance/legal-matters/[id]/steps/route"
import { GET as documentRoute } from "@/app/api/asset-finance/legal-matters/[id]/steps/[stepId]/document/route"
import { addSouthAfricanBusinessDays, isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"
import { fromDayNumber, toDayNumber } from "./dates"
import { cleanupRecoveryRows, today } from "./recovery.integration-fixture"
import { cleanupDealFixture } from "./deal.integration-fixture"

export function legalRoutes(host: string) {
  const request = (path: string, method: string, body?: unknown) => {
    const form = body instanceof FormData
    return new NextRequest(`http://${host}${path}`, {
      method,
      headers: form ? { host } : { host, "content-type": "application/json" },
      ...(body === undefined || method === "GET" ? {} : { body: form ? body : JSON.stringify(body) }),
    })
  }
  const base = "/api/asset-finance"
  return {
    open: (loanId: string) => openRoute(request(`${base}/loans/${loanId}/legal-matter`, "POST", {}), { params: Promise.resolve({ loanId }) }),
    loanView: (loanId: string) => loanViewRoute(request(`${base}/loans/${loanId}/legal-matter`, "GET"), { params: Promise.resolve({ loanId }) }),
    matter: (id: string) => matterRoute(request(`${base}/legal-matters/${id}`, "GET"), { params: Promise.resolve({ id }) }),
    appoint: (id: string, body: unknown) => attorneyRoute(request(`${base}/legal-matters/${id}/attorney`, "POST", body), { params: Promise.resolve({ id }) }),
    step: (id: string, body: unknown) => stepRoute(request(`${base}/legal-matters/${id}/steps`, "POST", body), { params: Promise.resolve({ id }) }),
    document: (id: string, stepId: string, download = false) =>
      documentRoute(request(`${base}/legal-matters/${id}/steps/${stepId}/document${download ? "?download=1" : ""}`, "GET"), { params: Promise.resolve({ id, stepId }) }),
  }
}

/** A multipart step with a PDF as evidence. */
export function stepWithEvidence(fields: Record<string, string>, text = "%PDF-1.4 synthetic court order"): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set("file", new File([new TextEncoder().encode(text)], "order.pdf", { type: "application/pdf" }))
  return form
}

/**
 * The SA business-day boundary a summons is judged on, today: `summonsOn` is
 * the last business day up to today; `matured` is the latest notice date that
 * is 10 business days old on it; `short` is the earliest that is not (one
 * business day short). Computed with the TypeScript calendar, so the suite
 * also pins it to the database's.
 */
export function summonsBoundary(): { summonsOn: string; matured: string; short: string } {
  let summonsOn = today()
  while (!isSouthAfricanBusinessDate(summonsOn)) summonsOn = fromDayNumber(toDayNumber(summonsOn) - 1)
  let matured = summonsOn
  while (addSouthAfricanBusinessDays(matured, 10) > summonsOn) matured = fromDayNumber(toDayNumber(matured) - 1)
  let short = fromDayNumber(toDayNumber(matured) + 1)
  while (addSouthAfricanBusinessDays(short, 10) <= summonsOn) short = fromDayNumber(toDayNumber(short) + 1)
  return { summonsOn, matured, short }
}

/** Removes the legal-matter rows the suite leaves outside the recovery cleanup, then the recovery and deal fixtures'. */
export async function cleanupLegalFixture(db: PrismaClient, tenantId: string): Promise<void> {
  const documents = await db.entityDocument.findMany({ where: { tenantId, docType: "LEGAL_DOCUMENT" }, select: { id: true, storagePath: true } })
  await Promise.all(documents.map((document) => unlink(document.storagePath).catch(() => undefined)))
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.documentAccessLog.deleteMany({ where: { documentId: { in: documents.map((document) => document.id) } } }),
    db.notification.deleteMany({ where: { tenantId } }),
    db.attorneyReferral.deleteMany({ where: { loan: { tenantId } } }),
    db.bureauAdverseConfirmation.deleteMany({ where: { tenantId } }),
  ])
  await cleanupRecoveryRows(db, tenantId)
  await cleanupDealFixture(db, { tenantId })
}
