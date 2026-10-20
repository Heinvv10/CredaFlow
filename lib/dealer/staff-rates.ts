/**
 * Commission rates (manage_dealers, checked by the route; spec deviation 2):
 * date-effective rows, a dealer's own or the tenant default (dealerId NULL).
 * A rate is never edited: a change is a new row from a new date, so the
 * approval snapshot (guardAssetDealDealer, dealerCommissionRateAt) always
 * resolves the rate in force on the approval date. One row per dealer (or
 * default) per date; the ceilings are CHECK DealerCommissionRate_bounds.
 * Commission is never a borrower charge (SLICE5.md, "NCA cost of credit
 * untouched"). Audited DEALER_COMMISSION_RATE_SET.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate, toDayNumber } from "@/lib/asset-finance/dates"
import type { StaffActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const MAX_COMMISSION_BPS = 1_000
export const MAX_COMMISSION_FLAT_CENTS = 10_000_000

export interface RateInput {
  effectiveFrom: string
  bps: number
  flatCents: number
}

const wholeIn = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max

export function parseRateInput(body: unknown): { data: RateInput } | { errors: Record<string, string> } {
  const record = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const effectiveFrom = typeof record.effectiveFrom === "string" ? record.effectiveFrom : ""
  try {
    toDayNumber(effectiveFrom, "effectiveFrom")
  } catch {
    errors.effectiveFrom = "must be a calendar date (YYYY-MM-DD)"
  }
  if (!wholeIn(record.bps, MAX_COMMISSION_BPS)) errors.bps = `must be whole basis points from 0 to ${MAX_COMMISSION_BPS}`
  if (!wholeIn(record.flatCents, MAX_COMMISSION_FLAT_CENTS)) errors.flatCents = `must be whole cents from 0 to ${MAX_COMMISSION_FLAT_CENTS}`
  if (Object.keys(errors).length > 0) return { errors }
  return { data: { effectiveFrom, bps: record.bps as number, flatCents: record.flatCents as number } }
}

/** A new rate row for `dealerId`, or the tenant default when `dealerId` is null. */
export async function setCommissionRate(
  staff: StaffActor,
  dealerId: string | null,
  input: RateInput,
): Promise<{ kind: "created"; rateId: string } | DealerRefusal> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (dealerId) {
        const dealer = await tx.dealer.findFirst({ where: { id: dealerId, tenantId: staff.tenantId }, select: { active: true } })
        if (!dealer) return dealerMiss("Dealer")
        if (!dealer.active) return dealerRefused(409, "The dealer is deactivated")
      }
      const row = await tx.dealerCommissionRate.create({
        data: {
          tenantId: staff.tenantId, dealerId, effectiveFrom: dbDate(input.effectiveFrom),
          bps: input.bps, flatCents: input.flatCents, createdById: staff.userId,
        },
        select: { id: true },
      })
      await logAuditStrict({
        tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
        action: AuditAction.DEALER_COMMISSION_RATE_SET, entity: "DealerCommissionRate", entityId: row.id,
        newValue: { scope: dealerId ? "DEALER" : "TENANT_DEFAULT", dealerId, ...input },
      }, tx)
      return { kind: "created" as const, rateId: row.id }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return dealerRefused(409, "A rate from this date already exists; rates are never edited, so choose another date")
    }
    throw error
  }
}
