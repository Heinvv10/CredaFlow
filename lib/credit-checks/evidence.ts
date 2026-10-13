/**
 * The checks panel's view of an application's flags: each flag with the
 * statement rows its evidence points at, read from the StatementAnalysis the
 * flag was raised on. Quoting those rows is document access, so the caller
 * logs it (lib/document-auth.ts logDocumentContentAccess) for every document
 * listed in `documentIds`.
 */
import type { ApplicationCheckFlag } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { StatementTransaction } from "@/lib/statement-analysis/types"

export interface EvidenceRow {
  index: number
  date: string
  description: string
  amountCents: number
  balanceCents: number | null
  page: number
}

export interface FlagView {
  id: string
  check: ApplicationCheckFlag["check"]
  code: string
  status: ApplicationCheckFlag["status"]
  summary: string
  raisedAt: string
  clearedAt: string | null
  clearReason: string | null
  clearedByName: string | null
  documentId: string | null
  documentName: string | null
  pages: number[]
  rows: EvidenceRow[]
}

const MAX_ROWS = 20

export async function flagViews(
  tenantId: string,
  flags: ApplicationCheckFlag[],
): Promise<{ flags: FlagView[]; documentIds: string[] }> {
  const visible = flags.filter((f) => f.status !== "SUPERSEDED")
  const ev = (f: ApplicationCheckFlag) => (f.evidence ?? {}) as Record<string, unknown>
  const analysisIds = [...new Set(visible.map((f) => ev(f).analysisId).filter((v): v is string => typeof v === "string"))]
  const docIds = [...new Set(visible.map((f) => ev(f).documentId).filter((v): v is string => typeof v === "string"))]
  const userIds = [...new Set(visible.map((f) => f.clearedById).filter((v): v is string => !!v))]

  const [analyses, docs, users] = await Promise.all([
    prisma.statementAnalysis.findMany({ where: { tenantId, id: { in: analysisIds } }, select: { id: true, transactions: true } }),
    prisma.clientDocument.findMany({ where: { tenantId, id: { in: docIds } }, select: { id: true, fileName: true } }),
    prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true, email: true } }),
  ])
  const txOf = new Map(analyses.map((a) => [a.id, a.transactions as unknown as StatementTransaction[]]))
  const nameOf = new Map(docs.map((d) => [d.id, d.fileName]))
  const userOf = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  const quoted = new Set<string>()

  const views = visible.map((f): FlagView => {
    const e = ev(f)
    const documentId = typeof e.documentId === "string" ? e.documentId : null
    const indexes = Array.isArray(e.transactionIndexes) ? (e.transactionIndexes as number[]).slice(0, MAX_ROWS) : []
    const all = typeof e.analysisId === "string" ? txOf.get(e.analysisId) ?? [] : []
    const rows = indexes.flatMap((index) => {
      const t = all[index]
      return t ? [{ index, date: t.date, description: t.description, amountCents: t.amountCents, balanceCents: t.balanceCents, page: t.page }] : []
    })
    if (rows.length > 0 && documentId) quoted.add(documentId)
    const pages = Array.isArray(e.pages) ? (e.pages as number[]) : [...new Set(rows.map((r) => r.page))]
    return {
      id: f.id,
      check: f.check,
      code: f.code,
      status: f.status,
      summary: f.summary,
      raisedAt: f.raisedAt.toISOString(),
      clearedAt: f.clearedAt?.toISOString() ?? null,
      clearReason: f.clearReason,
      clearedByName: f.clearedById ? userOf.get(f.clearedById) ?? null : null,
      documentId,
      documentName: documentId ? nameOf.get(documentId) ?? null : null,
      pages,
      rows,
    }
  })
  return { flags: views, documentIds: [...quoted] }
}
