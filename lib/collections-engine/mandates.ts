/**
 * Staff actions on a loan's DebiCheck mandate: set one up and cancel one.
 * Both refuse with FLAG_OFF while the tenant's engine is dark.
 */
import type { DebitMandate, DebitMandateAdjustment, DebitMandateAuthType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { avsWireAccountType } from "@/lib/avs"
import { sastCalendarDate } from "@/lib/date/sast"
import { validateMandateTerms } from "./scheme-rules"
import { debitDateOnOrAfter, earliestActionDate } from "./schedule"
import { LIVE_MANDATE_STATUSES } from "./state-machine"
import { dateOnly, isUniqueViolation, loadEngineContext } from "./context"
import { submitMandate, transitionMandate, type Actor } from "./mandate-lifecycle"

export type MandateErrorCode = "FLAG_OFF" | "NOT_FOUND" | "NOT_ELIGIBLE" | "INVALID_TERMS" | "LIVE_MANDATE_EXISTS" | "INVALID_STATE"

export class MandateError extends Error {
  constructor(readonly code: MandateErrorCode, message: string) {
    super(message)
    this.name = "MandateError"
  }
}

export interface CreateMandateInput {
  loanId: string
  authType: DebitMandateAuthType
  debitDay: number
  trackingDays: number
  /** Defaults to the largest outstanding instalment. */
  maxAmountCents?: number
  adjustment?: DebitMandateAdjustment
}

const AUTH_TYPES: readonly DebitMandateAuthType[] = ["TT1", "TT1_DELAYED", "TT2"]
const ADJUSTMENTS: readonly DebitMandateAdjustment[] = ["NEVER", "QUARTERLY", "BIANNUALLY", "ANNUALLY", "REPO_RATE"]

export async function createDebitMandate(tenantId: string, actor: Actor & { userId: string }, input: CreateMandateInput, now = new Date()): Promise<DebitMandate> {
  const ctx = await loadEngineContext(tenantId, now)
  if (!ctx) throw new MandateError("FLAG_OFF", "The collections engine is off for this lender")
  if (!AUTH_TYPES.includes(input.authType)) throw new MandateError("INVALID_TERMS", "Unknown authentication type")
  const adjustment = input.adjustment ?? "NEVER"
  if (!ADJUSTMENTS.includes(adjustment)) throw new MandateError("INVALID_TERMS", "Unknown adjustment category")

  const loan = await prisma.loan.findFirst({
    where: { id: input.loanId, tenantId },
    select: {
      id: true, reference: true, status: true, clientId: true,
      client: { select: { firstName: true, lastName: true, idNumber: true, phone: true, bankName: true, bankAccountNumber: true, bankBranchCode: true, accountType: true } },
      repaymentSchedule: { select: { dueDate: true, totalDue: true, totalPaid: true, status: true }, orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
    },
  })
  if (!loan) throw new MandateError("NOT_FOUND", "Loan not found")
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") throw new MandateError("NOT_ELIGIBLE", "Only an active or defaulted loan can be collected")
  const client = loan.client
  if (!client || !loan.clientId) throw new MandateError("NOT_ELIGIBLE", "DebiCheck for an entity borrower is not supported yet")
  if (!client.bankName || !client.bankAccountNumber || !client.bankBranchCode || !client.accountType) {
    throw new MandateError("NOT_ELIGIBLE", "Capture the client's bank name, branch, account number and type first")
  }
  try {
    avsWireAccountType(client.accountType)
  } catch (error) {
    throw new MandateError("NOT_ELIGIBLE", error instanceof Error ? error.message : "Unsupported account type")
  }

  const unpaid = loan.repaymentSchedule.filter((r) => r.status !== "PAID" && r.status !== "WRITTEN_OFF" && r.totalDue > r.totalPaid)
  if (unpaid.length === 0) throw new MandateError("NOT_ELIGIBLE", "Nothing is outstanding on the schedule")
  const amountCents = Math.max(...unpaid.map((r) => r.totalDue - r.totalPaid))
  const maxAmountCents = input.maxAmountCents ?? amountCents
  const invalid = validateMandateTerms({ amountCents, maxAmountCents, debitDay: input.debitDay, trackingDays: input.trackingDays })
  if (invalid) throw new MandateError("INVALID_TERMS", invalid)

  const firstDue = sastCalendarDate(unpaid[0].dueDate)
  const earliest = earliestActionDate(sastCalendarDate(now))
  const firstCollectionDate = debitDateOnOrAfter(firstDue > earliest ? firstDue : earliest, input.debitDay)

  let mandate: DebitMandate
  try {
    mandate = await prisma.$transaction(async (tx) => {
      const created = await tx.debitMandate.create({
        data: {
          tenantId, loanId: loan.id, clientId: loan.clientId!, provider: ctx.provider.id,
          authType: input.authType, amountCents, maxAmountCents, debitDay: input.debitDay,
          frequency: loan.repaymentSchedule.length > 1 ? "MONTHLY" : "ONCE_OFF",
          adjustment, trackingDays: input.trackingDays, firstCollectionDate: dateOnly(firstCollectionDate),
          accountHolder: `${client.firstName} ${client.lastName}`, bankName: client.bankName!,
          branchCode: client.bankBranchCode!, accountNumber: client.bankAccountNumber!, accountType: client.accountType!,
          createdById: actor.userId,
        },
      })
      await logAuditStrict({
        tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
        action: AuditAction.COLLECTION_MANDATE_CREATED, entity: "DebitMandate", entityId: created.id,
        newValue: {
          loanId: loan.id, provider: ctx.provider.id, authType: input.authType, amountCents, maxAmountCents,
          debitDay: input.debitDay, trackingDays: input.trackingDays, adjustment, firstCollectionDate,
          accountLast4: client.bankAccountNumber!.slice(-4),
        },
      }, tx)
      return created
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new MandateError("LIVE_MANDATE_EXISTS", "This loan already has a live mandate")
    throw error
  }
  const status = await submitMandate(ctx, mandate, loan.reference, client)
  const saved = await prisma.debitMandate.findFirstOrThrow({ where: { id: mandate.id, tenantId } })
  if (status === "CANCELLED") {
    throw new MandateError("NOT_ELIGIBLE", `${ctx.provider.id} could not register the mandate (${saved.statusReason ?? "no reason given"})`)
  }
  return saved
}

export async function cancelDebitMandate(tenantId: string, actor: Actor & { userId: string }, mandateId: string, reason: string, now = new Date()): Promise<DebitMandate> {
  const ctx = await loadEngineContext(tenantId, now)
  if (!ctx) throw new MandateError("FLAG_OFF", "The collections engine is off for this lender")
  const mandate = await prisma.debitMandate.findFirst({ where: { id: mandateId, tenantId } })
  if (!mandate) throw new MandateError("NOT_FOUND", "Mandate not found")
  if (![...LIVE_MANDATE_STATUSES, "SUSPENDED"].includes(mandate.status)) {
    throw new MandateError("INVALID_STATE", `A ${mandate.status.toLowerCase()} mandate cannot be cancelled`)
  }
  if (mandate.provider !== ctx.provider.id) {
    throw new MandateError("INVALID_STATE", `This mandate is held by ${mandate.provider}, not the configured provider`)
  }
  // Provider first: a mandate still live at the debtor's bank must not read as cancelled here.
  if (mandate.providerMandateRef) await ctx.provider.cancelMandate(mandate.providerMandateRef, ctx.creds)
  const moved = await transitionMandate({
    tenantId, mandateId, from: mandate.status, to: "CANCELLED", reason, actor, now,
  })
  if (!moved) throw new MandateError("INVALID_STATE", "The mandate changed while it was being cancelled; reload and retry")
  return prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId } })
}
