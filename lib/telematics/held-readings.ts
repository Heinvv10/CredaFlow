/**
 * Held tracker readings (docs/asset-finance/SLICE5.md part B), decided by staff
 * (manage_asset_finance). Accepting writes the reading as TELEMATICS with the
 * accepter as recordedById, outside the pace ceiling: the accepter vouches for
 * it. A reading below an earlier one, or above a later one, can never be
 * accepted (the monotonic rule); it is rejected, and a corrected STAFF reading
 * with evidence recorded if need be. Both are audited.
 */
import { Prisma, type TelematicsHeldReason, type TelematicsHeldStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { noteOf, objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

const NOT_MONOTONIC = {
  earlier: "A lower reading cannot be accepted; reject it or record a corrected reading with evidence",
  later: "A reading above a later reading cannot be accepted; reject it or record a corrected reading with evidence",
} as const

class Refused extends Error {
  constructor(readonly refusal: ReturnType<typeof refused>) {
    super(refusal.error)
  }
}

export async function acceptHeldReading(actor: TelematicsActor, heldId: string, body: unknown): Promise<TelematicsResult<{ readingId: string }>> {
  const { tenantId } = actor
  const raw = objectBody(body)?.note
  const note = raw === undefined || raw === null || raw === "" ? null : noteOf(raw)
  if (raw !== undefined && raw !== null && raw !== "" && !note) return refused(400, "A note is 3 to 500 characters", { note: "3 to 500 characters" })
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "TelematicsHeldReading" WHERE "id" = ${heldId} AND "tenantId" = ${tenantId} FOR UPDATE`
      const held = await tx.telematicsHeldReading.findFirst({ where: { id: heldId, tenantId } })
      if (!held) throw new Refused(refused(404, "Held reading not found"))
      if (held.status !== "HELD") throw new Refused(refused(409, "This reading is already decided"))
      const result = await recordMeterReading(tx, { tenantId, telematics: { eventId: held.eventId, acceptedById: actor.userId } }, {
        loanId: held.loanId, readingDate: isoOfDbDate(held.readingDate), value: held.value, evidenceDocumentId: null, today: sastCalendarDate(new Date()),
      })
      if (result.kind === "not_found") throw new Refused(refused(404, "The lease is not found"))
      if (result.kind === "refused") {
        throw new Refused(refused(422, result.reason === "not_monotonic" ? NOT_MONOTONIC[result.bound ?? "earlier"] : result.error))
      }
      await tx.telematicsHeldReading.update({
        where: { id: heldId, tenantId },
        data: { status: "ACCEPTED", decidedById: actor.userId, decidedAt: new Date(), decisionNote: note, meterReadingId: result.readingId },
      })
      await logAuditStrict({
        tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_HELD_READING_ACCEPTED, entity: "TelematicsHeldReading", entityId: heldId,
        newValue: { readingId: result.readingId, value: held.value, readingDate: isoOfDbDate(held.readingDate), reason: held.reason, note },
      }, tx)
      return { kind: "ok" as const, readingId: result.readingId }
    })
  } catch (error) {
    if (error instanceof Refused) return error.refusal
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return refused(409, "A tracker reading is already recorded for that day")
    if (isCheckViolation(error)) return refused(422, "The lease no longer takes tracker readings (its term ended, or it was terminated or closed)")
    throw error
  }
}

export async function rejectHeldReading(actor: TelematicsActor, heldId: string, body: unknown): Promise<TelematicsResult> {
  const { tenantId } = actor
  const note = noteOf(objectBody(body)?.note)
  if (!note) return refused(400, "Say why the reading is rejected (3 to 500 characters)", { note: "3 to 500 characters" })
  if (!(await prisma.telematicsHeldReading.findFirst({ where: { id: heldId, tenantId }, select: { id: true } }))) return refused(404, "Held reading not found")
  return prisma.$transaction(async (tx) => {
    const done = await tx.telematicsHeldReading.updateMany({
      where: { id: heldId, tenantId, status: "HELD" },
      data: { status: "REJECTED", decidedById: actor.userId, decidedAt: new Date(), decisionNote: note },
    })
    if (done.count !== 1) return refused(409, "This reading is already decided")
    await logAuditStrict({
      tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TELEMATICS_HELD_READING_REJECTED, entity: "TelematicsHeldReading", entityId: heldId,
      newValue: { note },
    }, tx)
    return { kind: "ok" as const }
  })
}

export interface HeldReadingRow {
  id: string
  loanId: string
  loanReference: string
  readingDate: string
  value: number
  unit: string
  reason: TelematicsHeldReason
  status: TelematicsHeldStatus
  simulated: boolean
  decisionNote: string | null
}

/** Held readings, newest first: undecided by default, optionally one loan's. */
export async function listHeldReadings(tenantId: string, filter: { status?: TelematicsHeldStatus; loanId?: string } = {}): Promise<HeldReadingRow[]> {
  const rows = await prisma.telematicsHeldReading.findMany({
    where: { tenantId, status: filter.status ?? "HELD", ...(filter.loanId ? { loanId: filter.loanId } : {}) },
    orderBy: { readingDate: "desc" },
    take: 200,
    select: {
      id: true, loanId: true, readingDate: true, value: true, unit: true, reason: true, status: true, decisionNote: true,
      loan: { select: { reference: true } }, event: { select: { simulated: true } },
    },
  })
  return rows.map(({ loan, event, readingDate, ...row }) => ({ ...row, readingDate: isoOfDbDate(readingDate), loanReference: loan.reference, simulated: event.simulated }))
}
