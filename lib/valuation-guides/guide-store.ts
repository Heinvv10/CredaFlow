/**
 * Loading, publishing and discarding a valuation guide (docs/asset-finance/
 * SLICE5.md part C). A guide is read by its provider and stored as a DRAFT
 * with its rows in one transaction; a second person publishes it, which
 * supersedes the current guide of that name in the same transaction. The
 * database repeats every rule (guardValuationGuide, ValuationGuide_four_eyes,
 * the one-current-per-name and live-file indexes); the checks here answer
 * first, with a reason a person can act on.
 */
import type { ValuationGuide } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { sastCalendarDate } from "@/lib/date/sast"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import type { GuideProblem, ValuationProvider } from "./types"

export interface GuideActor { tenantId: string; userId: string; userEmail: string }

export type CreateGuideResult =
  | { kind: "refused"; problems: GuideProblem[]; total: number }
  | { kind: "duplicate_file"; existingId: string }
  | { kind: "created"; guide: ValuationGuide }

export type PublishGuideResult =
  | { kind: "not_found" }
  | { kind: "not_draft"; status: string }
  | { kind: "self_publish" }
  | { kind: "not_yet_effective"; effectiveOn: string }
  | { kind: "older_than_current"; currentEffectiveOn: string }
  | { kind: "simulation_refused" }
  /** Another guide of that name went live at the same moment (ValuationGuide_one_current_per_name). */
  | { kind: "concurrent_publish" }
  | { kind: "published"; guide: ValuationGuide; superseded: string | null }

export type DiscardGuideResult = { kind: "not_found" } | { kind: "not_draft"; status: string } | { kind: "discarded"; guide: ValuationGuide }

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

const LIVE = ["DRAFT", "PUBLISHED"] as const
const isUniqueViolation = (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "P2002"

/**
 * Reads the guide with its provider and stores it as a DRAFT. A refused file
 * stores nothing and is audited with its counts, never its cell values. The
 * provider's NOT_CONFIGURED (a simulated provider on a deployed build) throws.
 */
export async function createDraftGuide(
  actor: GuideActor,
  input: { name: string; effectiveOn: string; provider: ValuationProvider; bytes?: Uint8Array },
): Promise<CreateGuideResult> {
  const { provider } = input
  provider.assertUsable()
  const read = await provider.readGuide({ bytes: input.bytes, effectiveOn: input.effectiveOn })
  if (!read.ok) {
    await auditRefusal({
      action: AuditAction.VALUATION_GUIDE_UPLOAD_REFUSED, entity: "ValuationGuide", entityId: "-", tenantId: actor.tenantId,
      userId: actor.userId, userEmail: actor.userEmail, reason: "malformed_guide", status: 422,
      detail: { name: input.name, provider: provider.id, problems: read.total, lines: read.problems.slice(0, 20).map((p) => p.line) },
    })
    return { kind: "refused", problems: read.problems, total: read.total }
  }
  const live = await prisma.valuationGuide.findFirst({
    where: { tenantId: actor.tenantId, fileSha256: read.sha256, status: { in: [...LIVE] } }, select: { id: true },
  })
  if (live) return { kind: "duplicate_file", existingId: live.id }
  try {
    const guide = await prisma.$transaction(async (tx) => {
      const created = await tx.valuationGuide.create({
        data: {
          tenantId: actor.tenantId, name: input.name, effectiveOn: dbDate(input.effectiveOn), provider: provider.id,
          simulated: provider.simulated, fileSha256: read.sha256, rowCount: read.rows.length, uploadedById: actor.userId,
        },
      })
      await tx.valuationGuideRow.createMany({ data: read.rows.map((row) => ({ tenantId: actor.tenantId, guideId: created.id, ...row })) })
      await logAuditStrict({
        tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.VALUATION_GUIDE_UPLOADED,
        entity: "ValuationGuide", entityId: created.id,
        newValue: { name: created.name, effectiveOn: input.effectiveOn, provider: provider.id, simulated: provider.simulated, sha256: read.sha256, rows: read.rows.length },
      }, tx)
      return created
    }, { timeout: 60_000 })
    return { kind: "created", guide }
  } catch (error) {
    // The same bytes loaded concurrently: ValuationGuide_live_file.
    if (!isUniqueViolation(error)) throw error
    const winner = await prisma.valuationGuide.findFirst({
      where: { tenantId: actor.tenantId, fileSha256: read.sha256, status: { in: [...LIVE] } }, select: { id: true },
    })
    if (!winner) throw error
    return { kind: "duplicate_file", existingId: winner.id }
  }
}

async function lockGuide(tx: Tx, tenantId: string, id: string): Promise<ValuationGuide | null> {
  await tx.$queryRaw`SELECT 1 FROM "ValuationGuide" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`
  return tx.valuationGuide.findFirst({ where: { id, tenantId } })
}

/** Publishes a DRAFT on a second person's word, superseding the current guide of that name. */
export async function publishGuide(actor: GuideActor, id: string): Promise<PublishGuideResult> {
  const result = await prisma.$transaction(async (tx): Promise<PublishGuideResult> => {
    const guide = await lockGuide(tx, actor.tenantId, id)
    if (!guide) return { kind: "not_found" }
    if (guide.status !== "DRAFT") return { kind: "not_draft", status: guide.status }
    if (guide.uploadedById === actor.userId) return { kind: "self_publish" }
    const effectiveOn = isoOfDbDate(guide.effectiveOn)
    if (effectiveOn > sastCalendarDate(new Date())) return { kind: "not_yet_effective", effectiveOn }
    if (guide.simulated && !isSimulationPermitted("simulated-valuation-guide")) return { kind: "simulation_refused" }
    // The current guide of that name, as ValuationGuide_one_current_per_name compares names.
    const [current] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ValuationGuide"
      WHERE "tenantId" = ${actor.tenantId} AND "status" = 'PUBLISHED' AND lower("name") = lower(${guide.name}) FOR UPDATE`
    const locked = current ? await tx.valuationGuide.findFirst({ where: { id: current.id, tenantId: actor.tenantId } }) : null
    if (locked && locked.status === "PUBLISHED") {
      if (locked.effectiveOn > guide.effectiveOn) return { kind: "older_than_current", currentEffectiveOn: isoOfDbDate(locked.effectiveOn) }
      await tx.valuationGuide.update({ where: { id: locked.id }, data: { status: "SUPERSEDED", supersededById: guide.id, supersededAt: new Date() } })
    }
    const published = await tx.valuationGuide.update({ where: { id: guide.id }, data: { status: "PUBLISHED", publishedById: actor.userId, publishedAt: new Date() } })
    const superseded = locked?.status === "PUBLISHED" ? locked.id : null
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.VALUATION_GUIDE_PUBLISHED,
      entity: "ValuationGuide", entityId: guide.id, oldValue: { status: "DRAFT" },
      newValue: { status: "PUBLISHED", name: guide.name, effectiveOn, supersededGuideId: superseded },
    }, tx)
    return { kind: "published", guide: published, superseded }
  }).catch((error: unknown): PublishGuideResult => {
    if (isUniqueViolation(error)) return { kind: "concurrent_publish" }
    throw error
  })
  if (result.kind === "self_publish") {
    await auditRefusal({
      action: AuditAction.VALUATION_GUIDE_PUBLISH_REFUSED, entity: "ValuationGuide", entityId: id, tenantId: actor.tenantId,
      userId: actor.userId, userEmail: actor.userEmail, reason: "four_eyes_self_publish", status: 403,
    })
  }
  return result
}

/** Discards a DRAFT (its uploader may): it never goes live, and its file may be loaded again. */
export async function discardGuide(actor: GuideActor, id: string): Promise<DiscardGuideResult> {
  return prisma.$transaction(async (tx): Promise<DiscardGuideResult> => {
    const guide = await lockGuide(tx, actor.tenantId, id)
    if (!guide) return { kind: "not_found" }
    if (guide.status !== "DRAFT") return { kind: "not_draft", status: guide.status }
    const discarded = await tx.valuationGuide.update({ where: { id }, data: { status: "DISCARDED", discardedById: actor.userId, discardedAt: new Date() } })
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.VALUATION_GUIDE_DISCARDED,
      entity: "ValuationGuide", entityId: id, oldValue: { status: "DRAFT" }, newValue: { status: "DISCARDED", name: guide.name },
    }, tx)
    return { kind: "discarded", guide: discarded }
  })
}
