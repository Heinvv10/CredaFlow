/**
 * The checks panel's view of an application's flags — superseded ones too, so
 * an officer sees a finding that went away — each with the statement rows its
 * evidence points at, read from the StatementAnalysis the flag was raised on.
 * Summaries and rows quote the statement, which is document access: the
 * caller logs every document listed in `documentIds`
 * (lib/document-auth.ts logDocumentContentAccess).
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

/** The adjacent statement a boundary row flag agrees with (statement-chain.ts): a hint, not proof. */
export interface ChainedWithView {
  documentId: string
  documentName: string | null
  periodStart: string
  periodEnd: string
  /** The previous statement closes, or the next one opens, at this balance. */
  relation: "previous" | "next"
  balanceCents: number
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
  chainedWith: ChainedWithView | null
}

const MAX_ROWS = 20

type Chained = Omit<ChainedWithView, "documentName">

function chainedWith(e: Record<string, unknown>): Chained | null {
  const c = (e.chainedWith ?? null) as Record<string, unknown> | null
  if (!c || typeof c.documentId !== "string" || typeof c.periodStart !== "string" || typeof c.periodEnd !== "string") return null
  const relation = typeof c.closingCents === "number" ? "previous" : typeof c.openingCents === "number" ? "next" : null
  if (!relation) return null
  return { documentId: c.documentId, periodStart: c.periodStart, periodEnd: c.periodEnd, relation, balanceCents: (relation === "previous" ? c.closingCents : c.openingCents) as number }
}

export async function flagViews(
  tenantId: string,
  flags: ApplicationCheckFlag[],
): Promise<{ flags: FlagView[]; documentIds: string[] }> {
  const ev = (f: ApplicationCheckFlag) => (f.evidence ?? {}) as Record<string, unknown>
  const analysisIds = [...new Set(flags.map((f) => ev(f).analysisId).filter((v): v is string => typeof v === "string"))]
  const docIds = [...new Set(flags.flatMap((f) => [ev(f).documentId, chainedWith(ev(f))?.documentId]).filter((v): v is string => typeof v === "string"))]
  // Every document a summary draws on is accessed by showing it, not only the linked one.
  const cited = [...new Set(flags.flatMap((f) => {
    const e = ev(f)
    return [e.documentId, e.payslipDocumentId, chainedWith(e)?.documentId, ...(Array.isArray(e.documentIds) ? e.documentIds : [])]
  }).filter((v): v is string => typeof v === "string"))]
  const userIds = [...new Set(flags.map((f) => f.clearedById).filter((v): v is string => !!v))]

  const [analyses, docs, users] = await Promise.all([
    prisma.statementAnalysis.findMany({ where: { tenantId, id: { in: analysisIds } }, select: { id: true, transactions: true } }),
    prisma.clientDocument.findMany({ where: { tenantId, id: { in: docIds } }, select: { id: true, fileName: true } }),
    prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true, email: true } }),
  ])
  const txOf = new Map(analyses.map((a) => [a.id, a.transactions as unknown as StatementTransaction[]]))
  const nameOf = new Map(docs.map((d) => [d.id, d.fileName]))
  const userOf = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  // Bidi overrides and control characters in statement text can make a row
  // read differently from what it says; the panel shows text, so strip them.
  const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")

  const views = flags.map((f): FlagView => {
    const e = ev(f)
    const documentId = typeof e.documentId === "string" ? e.documentId : null
    const indexes = Array.isArray(e.transactionIndexes) ? (e.transactionIndexes as number[]).slice(0, MAX_ROWS) : []
    const all = typeof e.analysisId === "string" ? txOf.get(e.analysisId) ?? [] : []
    const rows = indexes.flatMap((index) => {
      const t = all[index]
      return t ? [{ index, date: t.date, description: plain(t.description), amountCents: t.amountCents, balanceCents: t.balanceCents, page: t.page }] : []
    })
    const pages = Array.isArray(e.pages) ? (e.pages as number[]) : [...new Set(rows.map((r) => r.page))]
    const chained = chainedWith(e)
    return {
      id: f.id,
      check: f.check,
      code: f.code,
      status: f.status,
      summary: plain(f.summary),
      raisedAt: f.raisedAt.toISOString(),
      clearedAt: f.clearedAt?.toISOString() ?? null,
      clearReason: f.clearReason === null ? null : plain(f.clearReason),
      clearedByName: f.clearedById ? userOf.get(f.clearedById) ?? null : null,
      documentId,
      documentName: documentId ? plain(nameOf.get(documentId) ?? "") || null : null,
      pages,
      rows,
      chainedWith: chained ? { ...chained, documentName: plain(nameOf.get(chained.documentId) ?? "") || null } : null,
    }
  })
  return { flags: views, documentIds: cited }
}
