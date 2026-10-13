/**
 * Loads what the checks need about one application. Reads any statement that
 * has no current StatementAnalysis yet, text readers only: the vision reader
 * runs in the background from the upload path, never inside a staff request.
 */
import type { AppStatus, StatementAnalysis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { ensureStatementAnalysis } from "@/lib/statement-analysis/persist"
import type { AuthenticityFacts, StatementRead, StatementTransaction } from "@/lib/statement-analysis/types"
import { PAYSLIP_MONEY_FIELDS, type ExtractedFields } from "@/lib/vlm-extract"
import { STATEMENT_UPLOAD_LOOKBACK_DAYS } from "./policy"
import type { ApplicationFacts, DebtFacts, PayslipFacts, StatementFacts } from "./types"

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

export function statementFacts(documentId: string, a: StatementAnalysis): StatementFacts {
  const read: StatementRead | null = a.status === "READ"
    ? {
        accountHolderName: a.accountHolderName,
        accountNumberLast4: a.accountNumberLast4,
        periodStart: isoDay(a.periodStart),
        periodEnd: isoDay(a.periodEnd),
        openingBalanceCents: a.openingBalanceCents === null ? null : Number(a.openingBalanceCents),
        closingBalanceCents: a.closingBalanceCents === null ? null : Number(a.closingBalanceCents),
        transactions: a.transactions as unknown as StatementTransaction[],
      }
    : null
  return {
    documentId,
    analysisId: a.id,
    state: a.status,
    method: a.method,
    bank: a.bank,
    read,
    balanceCheck: a.balanceCheck,
    authenticity: a.authenticity as unknown as AuthenticityFacts,
  }
}

export function payslipFacts(documentId: string, extraction: unknown): PayslipFacts {
  const fields = (extraction ?? {}) as ExtractedFields
  const net = fields.netIncome?.value
  const payDate = fields.payDate?.value
  return {
    documentId,
    validated: PAYSLIP_MONEY_FIELDS.every((k) => fields[k]?.validated === true),
    netPayCents: typeof net === "number" && Number.isFinite(net) ? net : null,
    payDate: typeof payDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payDate) ? payDate : null,
  }
}

/** Bureau accounts as stored by lib/compliance/bureau-review.ts under obligations.accounts. */
export function bureauDebts(obligations: unknown): DebtFacts[] {
  const accounts = (obligations as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(accounts)) return []
  return accounts.flatMap((a: { subscriber?: unknown; instalmentCents?: unknown }) =>
    typeof a?.subscriber === "string" && typeof a.instalmentCents === "number"
      ? [{ name: a.subscriber, monthlyInstalmentCents: a.instalmentCents, source: "BUREAU" as const }]
      : [])
}

export async function loadApplicationFacts(
  tenantId: string,
  applicationId: string,
): Promise<{ facts: ApplicationFacts; status: AppStatus } | null> {
  const app = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: {
      id: true, status: true, clientId: true, submittedAt: true, createdAt: true,
      client: { select: { firstName: true, lastName: true, monthlyIncome: true, debtObligations: { select: { creditProvider: true, monthlyInstalment: true } } } },
    },
  })
  if (!app) return null
  const applicationDate = isoDay(app.submittedAt ?? app.createdAt)!
  const since = new Date(app.createdAt.getTime() - STATEMENT_UPLOAD_LOOKBACK_DAYS * 86_400_000)

  const [docs, slip, bureau] = await Promise.all([
    prisma.clientDocument.findMany({
      where: { tenantId, clientId: app.clientId, docType: "BANK_STATEMENT", deletedAt: null, createdAt: { gte: since } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clientDocument.findFirst({
      where: { tenantId, clientId: app.clientId, docType: "PAYSLIP", deletedAt: null, extractionStatus: "done" },
      select: { id: true, extractionResult: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.creditBureauCheck.findFirst({
      where: { tenantId, applicationId, ok: true },
      select: { obligations: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  const statements: StatementFacts[] = []
  for (const doc of docs) {
    const r = await ensureStatementAnalysis({ tenantId, documentId: doc.id, allowVlm: false })
    if (r.state === "read") statements.push(statementFacts(doc.id, r.analysis))
    else if (r.state === "pending") {
      statements.push({ documentId: doc.id, analysisId: null, state: "PENDING", method: null, bank: null, read: null, balanceCheck: null, authenticity: null })
    }
  }

  const payslip = slip ? payslipFacts(slip.id, slip.extractionResult) : null
  const debts: DebtFacts[] = [
    ...app.client.debtObligations.map((d) => ({ name: d.creditProvider, monthlyInstalmentCents: d.monthlyInstalment, source: "DECLARED" as const })),
    ...bureauDebts(bureau?.obligations),
  ]
  return {
    status: app.status,
    facts: {
      applicationId: app.id,
      applicationDate,
      clientName: `${app.client.firstName} ${app.client.lastName}`,
      monthlyIncomeCents: payslip?.validated && payslip.netPayCents !== null
        ? payslip.netPayCents
        : app.client.monthlyIncome > 0 ? app.client.monthlyIncome : null,
      statements,
      payslip,
      debts,
    },
  }
}
