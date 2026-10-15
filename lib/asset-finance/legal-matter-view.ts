import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "./dates"
import { nextLegalStepHint, type LegalRegime, type LegalStepHint, type LegalStepKind } from "./legal-matter-hint"

/** `usedByStepId`: the step the record already backs (a record backs one step; only a correction may name it again). */
export interface EligibleSection129Record { id: string; completedOn: string | null; usedByStepId: string | null }

export interface LegalMatterView {
  id: string
  loanId: string
  loanReference: string
  regime: LegalRegime
  status: "OPEN" | "CLOSED"
  caseNumber: string | null
  court: string | null
  attorney: { supplierId: string; name: string; appointedOn: string } | null
  createdById: string
  closedAt: string | null
  steps: {
    id: string; kind: LegalStepKind; stepDate: string; note: string | null; section129RecordId: string | null
    correctsStepId: string | null; hasEvidence: boolean; recordedById: string; createdAt: string
  }[]
  recoveryIds: string[]
  nextStep: LegalStepHint | null
  /** The loan's completed section 129 notices a S129_SENT step can name (NCA only). */
  eligibleSection129Records: EligibleSection129Record[]
}

export type LegalMatterViewResult = { kind: "not_found" } | { kind: "done"; view: LegalMatterView | null }

/** Completed section 129 notice records of a loan, newest first. A step is dated on or after its record's `completedOn`. */
export async function listEligibleSection129Records(tenantId: string, loanId: string): Promise<EligibleSection129Record[]> {
  const rows = await prisma.complianceRecord.findMany({
    where: { tenantId, referenceId: loanId, type: "SECTION_129_NOTICE", status: "COMPLETED" },
    select: { id: true, completedAt: true }, orderBy: { createdAt: "desc" },
  })
  const used = await prisma.legalMatterStep.findMany({
    where: { tenantId, section129RecordId: { in: rows.map((row) => row.id) }, correctsStepId: null }, select: { id: true, section129RecordId: true },
  })
  return rows.map((row) => ({
    id: row.id, completedOn: row.completedAt ? sastCalendarDate(row.completedAt) : null,
    usedByStepId: used.find((step) => step.section129RecordId === row.id)?.id ?? null,
  }))
}

/** A matter by id, or a loan's current matter (its open one, else the latest); `view: null` when the loan has none. */
export async function getLegalMatterView(tenantId: string, ref: { matterId: string } | { loanId: string }): Promise<LegalMatterViewResult> {
  if ("loanId" in ref && !await prisma.loan.count({ where: { id: ref.loanId, tenantId, assetId: { not: null } } })) return { kind: "not_found" }
  const matter = await prisma.legalMatter.findFirst({
    where: "matterId" in ref ? { id: ref.matterId, tenantId } : { tenantId, loanId: ref.loanId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      attorneySupplier: { select: { name: true } },
      loan: { select: { reference: true, ncaRegime: true } },
      steps: { orderBy: [{ stepDate: "asc" }, { createdAt: "asc" }] },
      recoveries: { select: { id: true } },
    },
  })
  if (!matter) return "matterId" in ref ? { kind: "not_found" } : { kind: "done", view: null }
  const regime = matter.loan.ncaRegime as LegalRegime
  const steps = matter.steps.map((step) => ({
    id: step.id, kind: step.kind, stepDate: isoOfDbDate(step.stepDate), note: step.note, section129RecordId: step.section129RecordId,
    correctsStepId: step.correctsStepId, hasEvidence: step.evidenceDocumentId !== null, recordedById: step.recordedById, createdAt: step.createdAt.toISOString(),
  }))
  return { kind: "done", view: {
    id: matter.id, loanId: matter.loanId, loanReference: matter.loan.reference, regime, status: matter.status, caseNumber: matter.caseNumber, court: matter.court,
    attorney: matter.attorneySupplierId && matter.attorneySupplier && matter.attorneyAppointedOn
      ? { supplierId: matter.attorneySupplierId, name: matter.attorneySupplier.name, appointedOn: isoOfDbDate(matter.attorneyAppointedOn) } : null,
    createdById: matter.createdById, closedAt: matter.closedAt?.toISOString() ?? null, steps,
    recoveryIds: matter.recoveries.map((recovery) => recovery.id),
    nextStep: matter.status === "OPEN" ? nextLegalStepHint(regime, steps) : null,
    eligibleSection129Records: regime === "NCA" ? await listEligibleSection129Records(tenantId, matter.loanId) : [],
  } }
}

/** A step's evidence document, only when the step is on this tenant's matter `matterId`. */
export async function findStepEvidence(tenantId: string, matterId: string, stepId: string) {
  const step = await prisma.legalMatterStep.findFirst({
    where: { id: stepId, matterId, tenantId, evidenceDocumentId: { not: null }, evidenceDocument: { deletedAt: null } },
    select: { evidenceDocument: { select: { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true } } },
  })
  return step?.evidenceDocument ?? null
}
