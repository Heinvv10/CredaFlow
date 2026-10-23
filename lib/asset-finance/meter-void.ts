/**
 * Voiding a wrong meter reading, four-eyes (docs/asset-finance/SLICE5-FOLLOWUPS.md
 * part T): one staff user requests it with a reason, a second approves or
 * rejects it. Any source (STAFF, PORTAL, TELEMATICS). The reading row stays;
 * the approval stamps it voided (the database does: applyAssetMeterReadingVoid)
 * and from then it counts for nothing: monotonic checks, start readings, the
 * excess projection, end-of-term billing, the telematics pace and one-a-day
 * rules. Refused for a final reading, a recovery's or a claim's reading, or a
 * reading of a lease whose end of term is invoiced (meterReadingVoidRefusal).
 * Both steps run in the lease route's transaction (leaseStaffAction), audited.
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { LeaseActionResult } from "./lease-route"
import type { SigningTx } from "./signing-prepare"

export const VOID_REASON_MIN = 10
export const VOID_REASON_MAX = 500

type Actor = { tenantId: string; userId: string; userEmail?: string | null }
const refused = (reason: string, error: string): LeaseActionResult => ({ kind: "refused", reason, error })

async function refusalOf(tx: SigningTx, tenantId: string, readingId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<Array<{ refusal: string | null }>>(Prisma.sql`SELECT "meterReadingVoidRefusal"(${tenantId}, ${readingId}) AS "refusal"`)
  return row?.refusal ?? null
}

export async function requestMeterReadingVoid(
  tx: SigningTx, actor: Actor, input: { loanId: string; readingId: string; reason: unknown },
): Promise<LeaseActionResult> {
  const { tenantId } = actor
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (reason.length < VOID_REASON_MIN || reason.length > VOID_REASON_MAX) {
    return refused("invalid_reason", `Say why the reading is wrong (${VOID_REASON_MIN} to ${VOID_REASON_MAX} characters)`)
  }
  const reading = await tx.assetMeterReading.findFirst({ where: { id: input.readingId, tenantId, loanId: input.loanId }, select: { id: true, value: true, readingDate: true, source: true } })
  if (!reading) return { kind: "not_found" }
  // Two requests at once queue here, so the second sees the first's PENDING row (one open request: the database's index).
  await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "AssetMeterReading" WHERE "id" = ${reading.id} AND "tenantId" = ${tenantId} FOR UPDATE`)
  const refusal = await refusalOf(tx, tenantId, reading.id)
  if (refusal) return refused("void_refused", refusal)
  if (await tx.assetMeterReadingVoid.count({ where: { tenantId, readingId: reading.id, status: "PENDING" } }) > 0) {
    return refused("void_pending", "A void of this reading is already waiting for a second person")
  }
  const request = await tx.assetMeterReadingVoid.create({ data: { tenantId, readingId: reading.id, reason, requestedById: actor.userId }, select: { id: true } })
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.METER_READING_VOID_REQUESTED,
    entity: "AssetMeterReading", entityId: reading.id,
    newValue: { voidId: request.id, loanId: input.loanId, reason, value: reading.value, source: reading.source },
  }, tx)
  return { kind: "requested", voidId: request.id }
}

export async function decideMeterReadingVoid(
  tx: SigningTx, actor: Actor, input: { loanId: string; voidId: string; decision: unknown },
): Promise<LeaseActionResult> {
  const { tenantId } = actor
  if (input.decision !== "APPROVE" && input.decision !== "REJECT") return refused("invalid_decision", "decision is APPROVE or REJECT")
  const request = await tx.assetMeterReadingVoid.findFirst({
    where: { id: input.voidId, tenantId, reading: { loanId: input.loanId } },
    select: { id: true, status: true, requestedById: true, readingId: true, reason: true },
  })
  if (!request) return { kind: "not_found" }
  if (request.status !== "PENDING") return refused("void_decided", "This void request is already decided")
  if (request.requestedById === actor.userId) return refused("four_eyes", "A second person decides a void: not the one who asked for it")
  if (input.decision === "APPROVE") {
    const refusal = await refusalOf(tx, tenantId, request.readingId)
    if (refusal) return refused("void_refused", refusal)
  }
  const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED"
  const decided = await tx.assetMeterReadingVoid.updateMany({
    where: { id: request.id, tenantId, status: "PENDING" },
    data: { status, decidedById: actor.userId, decidedAt: new Date() },
  })
  if (decided.count !== 1) return refused("void_decided", "This void request is already decided")
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
    action: status === "APPROVED" ? AuditAction.METER_READING_VOID_APPROVED : AuditAction.METER_READING_VOID_REJECTED,
    entity: "AssetMeterReading", entityId: request.readingId, newValue: { voidId: request.id, loanId: input.loanId, reason: request.reason },
  }, tx)
  return { kind: "decided", status }
}
