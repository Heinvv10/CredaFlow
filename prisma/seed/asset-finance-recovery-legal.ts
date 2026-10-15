/**
 * The legal matter of the seeded TLB recovery (slice 4a), written through the
 * same lib functions as the legal-matter routes: an open matter, the section
 * 129 notice record it stands on, the NCA step order (S129_SENT, attorney,
 * summons, judgment, attachment order, ASSET_RECOVERED, which opens the s131
 * recovery). The steps are dated in the past; the database refuses an order
 * that breaks the 10-business-day rule. Idempotent: a step already on the
 * matter is skipped.
 */
import type { LegalMatterStepKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import { appointAttorney, openLegalMatter } from "@/lib/asset-finance/legal-matter-store"
import { recordLegalStep } from "@/lib/asset-finance/legal-matter-step"
import type { LegalStepInput } from "@/lib/asset-finance/legal-matter-input"
import type { SeedActor } from "./asset-finance-documents"

const daysAgo = (today: string, days: number) => fromDayNumber(toDayNumber(today) - days)

async function ensureAttorney(tenantId: string, officer: SeedActor): Promise<string> {
  const name = "TEST Collections Attorneys Inc"
  const existing = await prisma.supplier.findFirst({ where: { tenantId, name }, select: { id: true } })
  if (existing) return existing.id
  return (await prisma.supplier.create({
    data: { tenantId, name, contactName: "TEST Attorney", contactEmail: "attorney@test.invalid", contactPhone: "0110000099", createdById: officer.id },
  })).id
}

/** The synthetic section 129 notice the matter stands on: issued and completed, in the past. */
async function ensureS129Record(tenantId: string, loanId: string, issuedOn: string): Promise<string> {
  const existing = await prisma.complianceRecord.findFirst({ where: { tenantId, type: "SECTION_129_NOTICE", referenceId: loanId, status: "COMPLETED" }, select: { id: true } })
  if (existing) return existing.id
  const at = new Date(`${issuedOn}T10:00:00+02:00`)
  return (await prisma.complianceRecord.create({
    data: { tenantId, type: "SECTION_129_NOTICE", referenceId: loanId, status: "COMPLETED", completedAt: at, data: { lifecycle: "ISSUED", syntheticSeed: true, issuedAt: at.toISOString() } },
  })).id
}

export interface TlbMatter { matterId: string; recoveryId: string }

/** Takes the loan's legal matter to the s131 recovery (RECOVERED) and returns both ids. */
export async function seedTlbLegalMatter(tenantId: string, officer: SeedActor, loanId: string, today: string): Promise<TlbMatter> {
  const actor = { tenantId, userId: officer.id, userEmail: officer.email }
  let matter = await prisma.legalMatter.findFirst({ where: { tenantId, loanId }, select: { id: true, attorneySupplierId: true } })
  if (!matter) {
    const opened = await openLegalMatter(actor, loanId)
    if (opened.kind !== "done") throw new Error(`Seed: legal matter refused (${JSON.stringify(opened)})`)
    matter = { id: opened.id, attorneySupplierId: null }
  }
  const matterId = matter.id
  const s129On = daysAgo(today, 60)
  const steps = new Set((await prisma.legalMatterStep.findMany({ where: { tenantId, matterId }, select: { kind: true } })).map((s) => s.kind))
  const record = async (kind: LegalMatterStepKind, stepDate: string, over: Partial<LegalStepInput> = {}) => {
    if (steps.has(kind)) return
    const result = await recordLegalStep(actor, matterId, {
      kind, stepDate, note: null, section129RecordId: null, correctsStepId: null, closeMatter: false, recovery: null, evidence: null, ...over,
    })
    if (result.kind !== "done") throw new Error(`Seed: legal step ${kind} refused (${JSON.stringify(result)})`)
  }

  if (!steps.has("S129_SENT")) {
    // The notice's effect on the loan: the collections stage the attorney appointment requires.
    await prisma.loan.update({ where: { id: loanId, tenantId }, data: { collectionsStage: "SECTION_129_SENT", collectionsStageUpdatedAt: new Date(`${s129On}T10:00:00+02:00`) } })
  }
  await record("S129_SENT", s129On, { section129RecordId: await ensureS129Record(tenantId, loanId, s129On), note: "Synthetic section 129 notice sent" })
  if (!matter.attorneySupplierId) {
    const appointed = await appointAttorney(actor, matterId, { supplierId: await ensureAttorney(tenantId, officer), appointedOn: daysAgo(today, 55) })
    if (appointed.kind !== "done") throw new Error(`Seed: attorney appointment refused (${JSON.stringify(appointed)})`)
  }
  const summons = daysAgo(today, 40)
  if (toDayNumber(addSouthAfricanBusinessDays(s129On, 10)) > toDayNumber(summons)) throw new Error("Seed: the summons date is inside the section 129 window")
  await record("SUMMONS_ISSUED", summons, { note: "Synthetic summons issued" })
  await record("SUMMONS_SERVED", daysAgo(today, 35))
  await record("JUDGMENT", daysAgo(today, 20), { note: "Synthetic default judgment" })
  await record("ATTACHMENT_ORDER", daysAgo(today, 10), { note: "Synthetic attachment order" })
  await record("ASSET_RECOVERED", daysAgo(today, 3), { recovery: { location: "TEST Sheriff's Yard, Johannesburg", condition: "Used, fair condition; hours as at the inspection." } })

  const recovery = await prisma.recovery.findFirst({ where: { tenantId, loanId, legalMatterId: matterId }, select: { id: true } })
  if (!recovery) throw new Error("Seed: the ASSET_RECOVERED step opened no recovery")
  return { matterId, recoveryId: recovery.id }
}
