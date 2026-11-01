/** What the loan page shows: whether the loan can be changed, the proposals on it and everything already applied. */
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { changeRefusal } from "./eligibility"
import { computeChange, factsOf, loadChangeLoan, type Computed } from "./compute"
import { parseLoanChangePayload } from "./payload"
import { LOAN_CHANGE_KIND, type LoanChangePayload } from "./types"
import { LoanChangeRefused } from "./plan"

export interface ChangePreview {
  refusal: string | null
  /** Rows the change would leave as the schedule; empty when refused. */
  rows: Array<{ installmentNo: number; dueDate: string; principalDue: number; interestDue: number; feesDue: number; totalDue: number; totalPaid: number }>
  principal: number
  outstandingPrincipal: number
  interestRatePm: number
  totalRepayable: number
  maturityDate: string | null
  carriedInterest: number
  carriedFees: number
  settledCents: number
  newMoneyCents: number
}

function previewOf(computed: Computed): ChangePreview {
  const iso = (d: Date) => d.toISOString()
  if (computed.scope === "IN_PLACE") {
    const { plan, loan } = computed
    return {
      refusal: null, rows: plan.rows.map((row) => ({ ...row, dueDate: iso(row.dueDate) })), principal: loan.principal, outstandingPrincipal: plan.outstandingPrincipal,
      interestRatePm: plan.interestRatePm, totalRepayable: plan.totalRepayable, maturityDate: iso(plan.maturityDate), carriedInterest: plan.carriedInterest, carriedFees: plan.carriedFees,
      settledCents: 0, newMoneyCents: 0,
    }
  }
  const { plan } = computed
  return {
    refusal: null, rows: plan.rows.map((row) => ({ ...row, dueDate: iso(row.dueDate), totalPaid: 0 })), principal: plan.principal, outstandingPrincipal: plan.principal,
    interestRatePm: computed.interestRatePm, totalRepayable: plan.totalRepayable, maturityDate: iso(plan.maturityDate), carriedInterest: 0, carriedFees: 0,
    settledCents: computed.settledCents, newMoneyCents: computed.newMoneyCents,
  }
}

const REFUSED: Omit<ChangePreview, "refusal"> = { rows: [], principal: 0, outstandingPrincipal: 0, interestRatePm: 0, totalRepayable: 0, maturityDate: null, carriedInterest: 0, carriedFees: 0, settledCents: 0, newMoneyCents: 0 }

/** The change as it would stand now. A refusal is the answer, not an error. */
export async function previewChange(tenantId: string, payload: LoanChangePayload, asOf = new Date()): Promise<ChangePreview> {
  try {
    return previewOf(await computeChange(prisma, tenantId, payload, asOf))
  } catch (error) {
    if (error instanceof LoanChangeRefused) return { ...REFUSED, refusal: error.message }
    throw error
  }
}

export interface LoanChangesView {
  inPlaceRefusal: string | null
  newLoanRefusal: string | null
  canPropose: boolean
  /** The borrower's documents a proposal can name as its signed paper. */
  documents: Array<{ id: string; fileName: string; docType: string }>
  otherLoans: Array<{ id: string; reference: string }>
  requests: Array<{
    id: string; status: string; type: string; title: string; reason: string; maker: string; checker: string | null; createdAt: string; decidedAt: string | null
    decisionNote: string | null; mine: boolean; canApprove: boolean; preview: ChangePreview | null; payload: LoanChangePayload
  }>
  applied: Array<{
    id: string; type: string; reason: string; maker: string; checker: string; appliedAt: string; restructured: boolean; loanId: string; newLoanId: string | null
    settledCents: number; newMoneyCents: number; signedDocumentId: string; before: unknown; after: unknown; scheduleBefore: unknown
  }>
  terms: Array<{ sequence: number; interestRatePm: number; frequency: string | null; structure: string | null; graceKind: string | null; graceInstalments: number; instalments: number | null; deferredInterest: number; createdAt: string }>
  restructuredAt: string | null
}

export async function loadLoanChangesView(tenantId: string, loanId: string, viewer: { id: string; role: string }): Promise<LoanChangesView | null> {
  const loan = await loadChangeLoan(prisma, tenantId, loanId)
  if (!loan) return null
  const facts = factsOf(loan)
  const [requests, applied, terms, documents, otherLoans] = await Promise.all([
    prisma.changeRequest.findMany({ where: { tenantId, kind: LOAN_CHANGE_KIND, payload: { path: ["loanId"], equals: loanId } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.loanChange.findMany({ where: { tenantId, OR: [{ loanId }, { newLoanId: loanId }, { sourceLoanIds: { has: loanId } }] }, orderBy: { appliedAt: "desc" } }),
    prisma.loanTerms.findMany({ where: { tenantId, loanId }, orderBy: { sequence: "asc" } }),
    loan.clientId ? prisma.clientDocument.findMany({ where: { tenantId, clientId: loan.clientId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, fileName: true, docType: true } }) : [],
    loan.clientId ? prisma.loan.findMany({ where: { tenantId, clientId: loan.clientId, id: { not: loanId }, status: { in: ["ACTIVE", "DEFAULTED"] } }, select: { id: true, reference: true } }) : [],
  ])
  const ids = [...new Set([...requests.flatMap((r) => [r.makerId, r.checkerId]), ...applied.flatMap((c) => [c.makerId, c.checkerId])].filter((id): id is string => id !== null))]
  const users = new Map((await prisma.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email]))
  const nameOf = (id: string | null) => (id ? users.get(id) ?? id : null)
  const mayApprove = canDo(viewer.role, "approve_loan_change")
  const presented = await Promise.all(requests.map(async (row) => {
    const payload = parseLoanChangePayload(row.payload)
    const open = row.status === "DRAFT" || row.status === "SUBMITTED"
    return {
      id: row.id, status: row.status, type: payload.type, title: row.title, reason: payload.reason, maker: nameOf(row.makerId)!, checker: nameOf(row.checkerId),
      createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null, decisionNote: row.decisionNote, payload,
      mine: row.makerId === viewer.id, canApprove: row.status === "SUBMITTED" && row.makerId !== viewer.id && mayApprove,
      preview: open ? await previewChange(tenantId, payload) : null,
    }
  }))
  return {
    inPlaceRefusal: changeRefusal(facts, "IN_PLACE"),
    newLoanRefusal: changeRefusal(facts, "NEW_LOAN"),
    canPropose: canDo(viewer.role, "propose_loan_change"),
    documents, otherLoans, requests: presented,
    applied: applied.map((c) => ({
      id: c.id, type: c.type, reason: c.reason, maker: nameOf(c.makerId)!, checker: nameOf(c.checkerId)!, appliedAt: c.appliedAt.toISOString(), restructured: c.markedRestructured,
      loanId: c.loanId, newLoanId: c.newLoanId, settledCents: c.settledCents, newMoneyCents: c.newMoneyCents, signedDocumentId: c.signedDocumentId, before: c.before, after: c.after, scheduleBefore: c.scheduleBefore,
    })),
    terms: terms.map((t) => ({ sequence: t.sequence, interestRatePm: t.interestRatePm, frequency: t.frequency, structure: t.structure, graceKind: t.graceKind, graceInstalments: t.graceInstalments, instalments: t.instalments, deferredInterest: t.deferredInterest, createdAt: t.createdAt.toISOString() })),
    restructuredAt: loan.restructuredAt?.toISOString() ?? null,
  }
}
