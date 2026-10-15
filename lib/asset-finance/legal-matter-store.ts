import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { wouldRegressCollectionsStage } from "@/lib/collections/stages"
import { prisma } from "@/lib/prisma"
import { dbDate } from "./dates"
import { loadHintSteps, notifyNextLegalStep } from "./legal-matter-bell"
import { attorneyAppointmentRefusal } from "./legal-matter-gate"
import { LegalRefusal, refusing } from "./legal-matter-guard"
import type { AppointAttorneyInput } from "./legal-matter-input"
import type { LegalRegime } from "./legal-matter-hint"
import type { SigningTx } from "./signing-prepare"

export interface LegalActor { tenantId: string; userId: string; userEmail?: string | null }
export type LegalResult = { kind: "not_found" } | { kind: "not_ready"; reason: string } | { kind: "done"; id: string }
export type AppointResult = LegalResult | { kind: "done"; id: string; stageSet: boolean }

const audit = (actor: LegalActor) => ({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined })

export async function openLegalMatter(actor: LegalActor, loanId: string): Promise<LegalResult> {
  return refusing<LegalResult>(() => prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, loanId)
    const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId, assetId: { not: null } }, select: { id: true } })
    if (!loan) return { kind: "not_found" }
    if (await tx.legalMatter.count({ where: { tenantId: actor.tenantId, loanId, status: "OPEN" } }) > 0) {
      throw new LegalRefusal("The loan already has an open legal matter")
    }
    const matter = await tx.legalMatter.create({ data: { tenantId: actor.tenantId, loanId, createdById: actor.userId } })
    await logAuditStrict({ ...audit(actor), action: AuditAction.LEGAL_MATTER_OPENED, entity: "LegalMatter", entityId: matter.id, newValue: { loanId } }, tx)
    return { kind: "done", id: matter.id }
  }), "The loan already has an open legal matter")
}

/**
 * Appoint (or re-appoint, while the matter is open) the attorney: the matter,
 * the loan's AttorneyReferral and, unless it would regress it, the loan's
 * collections stage move together. ATTORNEY_REFERRED is the stage the bureau
 * staff view lists an L as awaiting confirmation for; nothing is sent here.
 */
export async function appointAttorney(actor: LegalActor, matterId: string, input: AppointAttorneyInput): Promise<AppointResult> {
  return refusing<AppointResult>(() => prisma.$transaction(async (tx) => {
    const found = await tx.legalMatter.findFirst({ where: { id: matterId, tenantId: actor.tenantId }, select: { loanId: true } })
    if (!found) return { kind: "not_found" }
    await lockLoanForUpdate(tx, found.loanId)
    const matter = await tx.legalMatter.findFirst({ where: { id: matterId, tenantId: actor.tenantId } })
    if (!matter) return { kind: "not_found" }
    if (matter.status !== "OPEN") throw new LegalRefusal("The legal matter is closed")
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: actor.tenantId, active: true } })
    if (!supplier) throw new LegalRefusal("Choose an active supplier record for the attorney")
    const loan = await tx.loan.findFirst({ where: { id: matter.loanId, tenantId: actor.tenantId }, select: { id: true, reference: true, collectionsStage: true, ncaRegime: true } })
    if (!loan) return { kind: "not_found" }
    const refusal = attorneyAppointmentRefusal({
      regime: loan.ncaRegime as LegalRegime, collectionsStage: loan.collectionsStage, steps: await loadHintSteps(tx, actor.tenantId, matter.id),
      // The notice the manual attorney-referral route requires: issued and completed.
      hasIssuedNotice: await tx.complianceRecord.count({
        where: { tenantId: actor.tenantId, type: "SECTION_129_NOTICE", referenceId: loan.id, status: "COMPLETED", completedAt: { not: null }, data: { path: ["lifecycle"], equals: "ISSUED" } },
      }) > 0,
    })
    if (refusal) throw new LegalRefusal(refusal)
    await tx.legalMatter.update({ where: { id: matter.id, tenantId: actor.tenantId }, data: { attorneySupplierId: supplier.id, attorneyAppointedOn: dbDate(input.appointedOn) } })
    const referral = {
      firmId: null, firmName: supplier.name, contactPerson: supplier.contactName, contactPhone: supplier.contactPhone, contactEmail: supplier.contactEmail,
      referralDate: dbDate(input.appointedOn), matterNumber: matter.caseNumber, createdById: actor.userId,
    }
    await tx.attorneyReferral.upsert({ where: { loanId: loan.id }, create: { loanId: loan.id, ...referral }, update: referral })
    const stageSet = loan.collectionsStage !== "ATTORNEY_REFERRED" && !wouldRegressCollectionsStage(loan.collectionsStage, "ATTORNEY_REFERRED")
    if (stageSet) await tx.loan.update({ where: { id: loan.id, tenantId: actor.tenantId }, data: { collectionsStage: "ATTORNEY_REFERRED", collectionsStageUpdatedAt: new Date() } })
    await logAuditStrict({
      ...audit(actor), action: AuditAction.LEGAL_MATTER_ATTORNEY_APPOINTED, entity: "LegalMatter", entityId: matter.id,
      oldValue: { attorneySupplierId: matter.attorneySupplierId, collectionsStage: loan.collectionsStage },
      newValue: { loanId: loan.id, attorneySupplierId: supplier.id, appointedOn: input.appointedOn, collectionsStage: stageSet ? "ATTORNEY_REFERRED" : loan.collectionsStage },
    }, tx)
    await notifyNextLegalStep(tx, {
      tenantId: actor.tenantId, matterId: matter.id, loanReference: loan.reference, regime: loan.ncaRegime as LegalRegime,
      recipients: [matter.createdById, actor.userId],
    })
    return { kind: "done", id: matter.id, stageSet }
  }), "The legal matter changed; reload it and try again")
}

/** Close an open matter (terminal). Runs in the caller's transaction. */
export async function closeLegalMatterTx(tx: SigningTx, actor: LegalActor, matterId: string, reason: string): Promise<void> {
  await tx.legalMatter.update({ where: { id: matterId, tenantId: actor.tenantId }, data: { status: "CLOSED", closedAt: new Date() } })
  await logAuditStrict({ ...audit(actor), action: AuditAction.LEGAL_MATTER_CLOSED, entity: "LegalMatter", entityId: matterId, newValue: { reason } }, tx)
}
