/**
 * Loads what the checks need about one application. Reads any statement that
 * has no current StatementAnalysis yet, text readers only: the vision reader
 * runs in the background from the upload path, never inside a staff request.
 */
import { simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import type { AppStatus, StatementAnalysis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { needsModelLabels } from "@/lib/statement-analysis/model-labels"
import { ensureStatementAnalysis, readStatementInBackground } from "@/lib/statement-analysis/persist"
import { PARSER_VERSION } from "@/lib/statement-analysis/analyse"
import type { AuthenticityFacts, StatementRead, StatementTransaction } from "@/lib/statement-analysis/types"
import { PAYSLIP_MONEY_FIELDS, type ExtractedFields } from "@/lib/vlm-extract"
import { areNamesSimilar } from "@/lib/ocr/name-matching"
import { STATEMENT_UPLOAD_LOOKBACK_DAYS } from "./policy"
import { hasClientBorrower } from "@/lib/borrower"
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
    contentSha256: a.contentSha256,
    state: a.status,
    method: a.method,
    bank: a.bank,
    read,
    balanceCheck: a.balanceCheck,
    authenticity: a.authenticity as unknown as AuthenticityFacts,
    modelLabels: a.modelCategories,
  }
}

export interface ClientIdentity {
  fullName: string
  idNumber: string | null
}

/**
 * Whether the payslip is the client's: the employee ID number printed on it,
 * or failing that the employee name, against the client record. The upload
 * validator only warns on a payslip, so this check is the one that decides.
 * Neither readable means it is not confirmed — fail closed.
 */
export function payslipNamesClient(fields: ExtractedFields, client: ClientIdentity): boolean {
  // The model may answer a number as a JSON number; read it as text either way.
  const digits = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "")
  const printedId = digits(fields.employeeIdNumber?.value)
  const clientId = digits(client.idNumber)
  // Any digits printed as the ID decide it: they must carry the client's ID.
  // A misread, an employee number or a stranger's ID never falls through to
  // the more lenient name match.
  if (printedId) return clientId.length === 13 && printedId.includes(clientId)
  const printedName = fields.employeeName?.value
  return typeof printedName === "string" && printedName.trim() !== "" && areNamesSimilar(printedName, client.fullName)
}

export function payslipFacts(documentId: string, extraction: unknown, validationMismatch: boolean, client: ClientIdentity): PayslipFacts {
  const fields = (extraction ?? {}) as ExtractedFields
  const net = fields.netIncome?.value
  const payDate = fields.payDate?.value
  return {
    documentId,
    validated: PAYSLIP_MONEY_FIELDS.every((k) => fields[k]?.validated === true),
    matchesClient: !validationMismatch && payslipNamesClient(fields, client),
    netPayCents: typeof net === "number" && Number.isFinite(net) ? net : null,
    payDate: typeof payDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payDate) ? payDate : null,
  }
}

/** Bureau accounts as stored by lib/compliance/bureau-review.ts under obligations.accounts. */
export function bureauDebts(obligations: unknown, provider?: string): DebtFacts[] {
  const accounts = (obligations as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(accounts)) return []
  // A simulated account list is fabricated: not evidence where simulation is forbidden.
  if (simulatedBureauBlock({ obligations, provider }).blocked) return []
  return accounts.flatMap((a: { subscriber?: unknown; instalmentCents?: unknown; status?: unknown }) =>
    // A closed or settled account explains no current debit order.
    typeof a?.subscriber === "string" && typeof a.instalmentCents === "number"
      && !(typeof a.status === "string" && CLOSED_ACCOUNT.test(a.status))
      ? [{ name: a.subscriber, monthlyInstalmentCents: a.instalmentCents, source: "BUREAU" as const }]
      : [])
}

const CLOSED_ACCOUNT = /CLOSED|SETTLED|PAID UP|WRITTEN OFF/i

/** A payslip's identity and extraction state: any change means the checks did not see it. */
export function payslipStateKey(d: { id: string; extractionStatus: string; extractionGeneration: string | null }): string {
  return `${d.id}:${d.extractionStatus}:${d.extractionGeneration ?? ""}`
}

/**
 * Every statement in the window with its newest read: the recompute records
 * it and the approval compares it under the lock, through this one query, so
 * the two can only differ when the evidence did (model labels included). Consent-pending, unread and
 * file-less statements are keyed the same way on both sides.
 */
export async function statementSnapshot(
  db: { clientDocument: Pick<typeof prisma.clientDocument, "findMany"> },
  where: { tenantId: string; clientId: string; since: Date },
): Promise<string[]> {
  const docs = await db.clientDocument.findMany({
    where: { tenantId: where.tenantId, clientId: where.clientId, docType: "BANK_STATEMENT", deletedAt: null, createdAt: { gte: where.since } },
    select: { id: true, statementAnalyses: { where: { parserVersion: PARSER_VERSION }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, modelCategoriesAt: true } } },
  })
  // Model labels stored on a read change its evidence: a read labelled since is a different key.
  return docs.map((d) => {
    const a = d.statementAnalyses[0]
    return `${d.id}:${a?.id ?? ""}${a?.modelCategoriesAt ? `:${a.modelCategoriesAt.toISOString()}` : ""}`
  }).sort()
}

/**
 * The client's declared monthly expenses, or null when none were captured.
 * 0 is the column's default, so it is a declaration only when the capture was
 * recorded; a figure above 0 always is (clients captured before the record existed).
 */
export function declaredExpenses(c: { monthlyExpenses: number; monthlyExpensesDeclaredAt: Date | null }): number | null {
  return c.monthlyExpenses > 0 || c.monthlyExpensesDeclaredAt !== null ? c.monthlyExpenses : null
}

export interface LoadOptions {
  /**
   * Use only reads already persisted, never run the readers: for the reload
   * under the application row lock, after a first pass has done the reading.
   */
  persistedOnly?: boolean
  /** The transaction holding the application lock: every query runs on it. */
  db?: Pick<typeof prisma, "loanApplication" | "clientDocument" | "creditBureauCheck" | "statementAnalysis">
  /** With persistedOnly: why each statement was still pending in the first pass. */
  pendingReasons?: Map<string, NonNullable<StatementFacts["pendingReason"]>>
}

export async function loadApplicationFacts(
  tenantId: string,
  applicationId: string,
  opts: LoadOptions = {},
): Promise<{ facts: ApplicationFacts; status: AppStatus; payslipSnapshot: string[]; statementSnapshot: string[]; since: Date } | null> {
  const app = await (opts.db ?? prisma).loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: {
      id: true, status: true, clientId: true, submittedAt: true, createdAt: true,
      client: { select: { firstName: true, lastName: true, idNumber: true, monthlyIncome: true, monthlyExpenses: true, monthlyExpensesDeclaredAt: true, popiaConsentGiven: true, debtObligations: { select: { creditProvider: true, monthlyInstalment: true } } } },
    },
  })
  // Consumer credit checks read a natural person's statements, payslips and
  // bureau record; an entity (asset-finance) application has none.
  if (!app || !hasClientBorrower(app)) return null
  const applicationDate = isoDay(app.submittedAt ?? app.createdAt)!
  const since = new Date(app.createdAt.getTime() - STATEMENT_UPLOAD_LOOKBACK_DAYS * 86_400_000)
  // A document deleted recently counts however long ago it was uploaded: waiting
  // out the window and then deleting must not hide what it showed.
  const deletedInWindow = { deletedAt: { not: null }, OR: [{ createdAt: { gte: since } }, { deletedAt: { gte: since } }] }
  const identity: ClientIdentity = { fullName: `${app.client.firstName} ${app.client.lastName}`, idNumber: app.client.idNumber }

  const db = opts.db ?? prisma
  // Taken before anything is read: a statement landing after it differs at
  // approval and fails closed, never the other way round.
  const statementKeys = await statementSnapshot(db, { tenantId, clientId: app.clientId, since })
  const [docs, deleted, payslipDocs, deletedSlips, priorFlagged, bureau] = await Promise.all([
    db.clientDocument.findMany({
      where: { tenantId, clientId: app.clientId, docType: "BANK_STATEMENT", deletedAt: null, createdAt: { gte: since } },
      select: { id: true, uploadedByType: true },
      orderBy: { createdAt: "asc" },
    }),
    db.clientDocument.findMany({
      where: { tenantId, clientId: app.clientId, docType: "BANK_STATEMENT", ...deletedInWindow, statementAnalyses: { some: {} } },
      select: { id: true },
    }),
    db.clientDocument.findMany({
      where: { tenantId, clientId: app.clientId, docType: "PAYSLIP", deletedAt: null, createdAt: { gte: since } },
      select: { id: true, extractionStatus: true, extractionGeneration: true, extractionResult: true, validationMismatch: true },
      orderBy: { createdAt: "desc" },
    }),
    db.clientDocument.findMany({
      where: { tenantId, clientId: app.clientId, docType: "PAYSLIP", ...deletedInWindow },
      select: { id: true },
    }),
    // Starting another application — cancelling, declining or abandoning this
    // one, however long ago — must not leave its open findings where no one
    // looks. Substantive findings only: a PRIOR flag does not breed more.
    db.loanApplication.findMany({
      where: { tenantId, clientId: app.clientId, id: { not: applicationId }, checkFlags: { some: { status: "OPEN", code: { not: "PRIOR_OPEN_FLAGS" } } } },
      select: { id: true, reference: true, status: true },
    }),
    db.creditBureauCheck.findFirst({
      where: { tenantId, applicationId, ok: true },
      select: { obligations: true, provider: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  const statements: StatementFacts[] = []
  const pending = (documentId: string, pendingReason: StatementFacts["pendingReason"]): StatementFacts => ({
    documentId, analysisId: null, contentSha256: null, state: "PENDING", pendingReason, method: null, bank: null, read: null, balanceCheck: null, authenticity: null,
  })
  for (const doc of docs) {
    // The upload path's consent gate (app/api/documents): a statement a client
    // uploaded without POPIA consent is not processed here either.
    if (doc.uploadedByType !== "staff" && !app.client.popiaConsentGiven) {
      statements.push(pending(doc.id, "consent"))
      continue
    }
    const r = await ensureStatementAnalysis({ tenantId, documentId: doc.id, allowVlm: false, persistedOnly: opts.persistedOnly, db: opts.persistedOnly ? opts.db : undefined })
    if (r.state === "read") {
      statements.push(statementFacts(doc.id, r.analysis))
      // A read the model has not labelled — it was down, or the read came
      // before the labels did — is labelled in the background, and the
      // client's checks recomputed once it is.
      if (!opts.persistedOnly && needsModelLabels(r.analysis)) {
        readStatementInBackground(tenantId, doc.id, {
          onLabelled: async () => (await import("./recompute")).recomputeClientApplications(tenantId, app.clientId),
        })
      }
    } else if (r.state === "pending") {
      const reason = r.reason === "file_missing" || r.reason === "reader_unavailable" ? r.reason : opts.pendingReasons?.get(doc.id) ?? "vlm"
      statements.push(pending(doc.id, reason))
      // A read the vision model has not done yet — the model was down, or the
      // process restarted before its queue ran — is queued again here.
      if (reason === "vlm" && !opts.persistedOnly) readStatementInBackground(tenantId, doc.id)
    }
  }

  const slips = payslipDocs.filter((d) => d.extractionStatus === "done")
  const slipFacts = slips.map((d) => payslipFacts(d.id, d.extractionResult, d.validationMismatch, identity))
  const payslip = slipFacts[0] ?? null
  // The lower of the payslip and the declared income: a payslip can only make
  // the income-relative checks stricter, never looser.
  const declared = app.client.monthlyIncome > 0 ? app.client.monthlyIncome : null
  const slipNet = payslip?.validated && payslip.matchesClient ? payslip.netPayCents : null
  const income = slipNet !== null && declared !== null ? Math.min(slipNet, declared) : slipNet ?? declared
  const debts: DebtFacts[] = [
    ...app.client.debtObligations.map((d) => ({ name: d.creditProvider, monthlyInstalmentCents: d.monthlyInstalment, source: "DECLARED" as const })),
    ...bureauDebts(bureau?.obligations, bureau?.provider),
  ]
  return {
    status: app.status,
    // Every payslip in the window as it stood: the approval refuses if it changed.
    payslipSnapshot: payslipDocs.map(payslipStateKey),
    statementSnapshot: statementKeys,
    since,
    facts: {
      applicationId: app.id,
      applicationDate,
      clientName: `${app.client.firstName} ${app.client.lastName}`,
      monthlyIncomeCents: income,
      declaredExpensesCents: declaredExpenses(app.client),
      statements,
      deletedStatementIds: deleted.map((d) => d.id),
      mismatchedPayslipIds: slipFacts.filter((s) => !s.matchesClient).map((s) => s.documentId),
      unreadPayslipIds: payslipDocs.filter((d) => d.extractionStatus !== "done").map((d) => d.id),
      deletedPayslipIds: deletedSlips.map((d) => d.id),
      extractedPayslipIds: slips.map((d) => d.id),
      priorOpenFlagApplications: priorFlagged,
      payslip,
      debts,
    },
  }
}
