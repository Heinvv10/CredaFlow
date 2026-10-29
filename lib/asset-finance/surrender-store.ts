import type { ValuationSource } from "@prisma/client"
import { requireNcrNumber } from "@/lib/config/identity-schema"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { getLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { renderSurrenderFinalNotice, renderSurrenderValuationNotice, type SurrenderNoticeData } from "./documents/nca/surrender-pdf"
import { legalWordingApproved } from "./documents/nca/legal-wording-approved"
import { dbDate, isoOfDbDate } from "./dates"
import { readVerified } from "./notice-bytes"
import { COST_TYPE_LABELS } from "./recovery-labels"
import { issueNcaSurplusRemittance, ncaSurplusNoticeDetails } from "./nca-surplus"
import { surrenderOutcome } from "./surrender-calculation"
import { RecoveryRefusal, refusable } from "./recovery-result"
import { requireNcaSaleWindow } from "./surrender-lifecycle"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import type { SigningTx } from "./signing-prepare"
import { surrenderRequestOpen } from "./surrender-request-gate"

const RECOVERY_HANDLES_PROCEEDS = "Sale proceeds for this surrender go through its recovery"

interface Actor { tenantId: string; userId: string; userEmail?: string | null }
type Result = { kind: "not_found" } | { kind: "not_ready"; reason: string } | { kind: "done"; id: string }

export async function requestSurrender(actor: Actor, loanId: string, assetCondition: string, requestedBy: "CLIENT" | "STAFF"): Promise<Result> {
  const condition = assetCondition.trim()
  if (condition.length < 3 || condition.length > 2_000) return { kind: "not_ready", reason: "Describe the asset condition in 3 to 2000 characters" }
  const loan = await prisma.loan.findFirst({
    where: {
      id: loanId, tenantId: actor.tenantId, ncaRegime: "NCA", contractType: { not: "LOAN" },
      status: { in: ["ACTIVE", "DEFAULTED"] }, assetId: { not: null },
      ...(requestedBy === "CLIENT" ? { OR: [
        { clientId: actor.userId },
        { entity: { relationships: { some: { clientId: actor.userId, active: true, role: { in: ["DIRECTOR", "MEMBER", "TRUSTEE", "AUTHORISED_SIGNATORY"] } } } } },
      ] } : {}),
    },
    select: { id: true, assetId: true, asset: { select: { lessorStatus: true } }, recoveries: { select: { status: true } } },
  })
  if (!loan?.assetId) return { kind: "not_found" }
  if (!surrenderRequestOpen({ recoveryStatuses: loan.recoveries.map((r) => r.status), lessorStatus: loan.asset?.lessorStatus ?? null })) {
    return { kind: "not_ready", reason: "The asset is already in the lender's possession" }
  }
  const assetId = loan.assetId
  const requestedOn = sastCalendarDate(new Date())
  // The s127 statutory valuation window and citation are signed off (see DESIGN.md sign-off record 2026-10-17).
  const valuationDueOn = addSouthAfricanBusinessDays(requestedOn, 10)
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.surrenderRequest.create({ data: {
      tenantId: actor.tenantId, loanId, assetId, requestedByType: requestedBy,
      requestedById: actor.userId, requestedOn: dbDate(requestedOn), assetCondition: condition,
      valuationDueOn: dbDate(valuationDueOn),
    } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: requestedBy === "STAFF" ? actor.userId : undefined,
      userEmail: actor.userEmail ?? undefined, action: AuditAction.ASSET_SURRENDER_REQUESTED,
      entity: "SurrenderRequest", entityId: created.id,
      newValue: { loanId, assetId, requestedBy, requestedById: actor.userId, requestedOn, valuationDueOn, assetCondition: condition },
    }, tx)
    return created
  })
  return { kind: "done", id: row.id }
}

export async function recordSurrenderValuation(actor: Actor, id: string, input: { valuedOn: string; source: ValuationSource; valuerName: string; amountCents: number }): Promise<Result> {
  const valuerName = input.valuerName.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.valuedOn) || !valuerName || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return { kind: "not_ready", reason: "Provide a valid date, valuer and positive valuation in cents" }
  }
  return prisma.$transaction(async (tx) => {
    const request = await tx.surrenderRequest.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true, status: true, assetId: true } })
    if (!request) return { kind: "not_found" }
    if (request.status !== "REQUESTED") return { kind: "not_ready", reason: "The surrender is not awaiting valuation" }
    const valuation = await tx.assetValuation.create({ data: {
      tenantId: actor.tenantId, assetId: request.assetId, valuedOn: dbDate(input.valuedOn), source: input.source,
      valuerName, amountCents: input.amountCents, createdById: actor.userId,
    } })
    await tx.surrenderRequest.update({ where: { id, tenantId: actor.tenantId }, data: { status: "VALUED", valuationId: valuation.id } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_SURRENDER_VALUED, entity: "SurrenderRequest", entityId: id,
      newValue: { valuationId: valuation.id, valuedOn: input.valuedOn, source: input.source, valuerName, amountCents: input.amountCents },
    }, tx)
    return { kind: "done", id }
  })
}

export async function issueSurrenderNotice(actor: Actor, id: string, kind: "valuation" | "final"): Promise<Result> {
  return refusable(() => issueSurrenderNoticeChecked(actor, id, kind))
}

async function issueSurrenderNoticeChecked(actor: Actor, id: string, kind: "valuation" | "final"): Promise<Result> {
  const request = await loadNoticeData(actor.tenantId, id)
  if (!request) return { kind: "not_found" }
  const expected = kind === "valuation" ? "VALUED" : "PROCEEDS_CREDITED"
  if (request.status !== expected) return { kind: "not_ready", reason: `The surrender is not ready for its ${kind} notice` }
  const renderedAt = new Date()
  const data = await noticeData(actor.tenantId, request, renderedAt)
  const bytes = kind === "valuation" ? await renderSurrenderValuationNotice(data) : await renderSurrenderFinalNotice(data)
  const sha256 = sha256DocumentBytes(bytes)
  const stored = await saveFile(bytes, "application/pdf")
  try {
    await prisma.$transaction(async (tx) => {
      if (kind === "final") {
        const remittance = await issueNcaSurplusRemittance(tx, actor, { loanId: request.loanId, surrenderId: id, amountCents: request.refundCents ?? 0 }, true)
        if (remittance && remittance.status !== data.surplusDisposition) throw new RecoveryRefusal("Bank verification changed while rendering the notice; retry")
      }
      await tx.surrenderRequest.update({ where: { id, tenantId: actor.tenantId }, data: kind === "valuation"
        ? { status: "VALUATION_NOTICE_ISSUED", valuationNoticePath: stored.storagePath, valuationNoticeSha256: sha256 }
        : { status: "FINAL_NOTICE_ISSUED", finalNoticePath: stored.storagePath, finalNoticeSha256: sha256 } })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
        action: kind === "valuation" ? AuditAction.ASSET_SURRENDER_VALUATION_NOTICE_ISSUED : AuditAction.ASSET_SURRENDER_FINAL_NOTICE_ISSUED,
        entity: "SurrenderRequest", entityId: id, newValue: { sha256, storagePath: stored.storagePath, surplusDisposition: data.surplusDisposition, draftLegalWording: !data.legalWordingApproved },
      }, tx)
      if (kind === "final" && (request.refundCents ?? 0) > 0) await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
    })
  } catch (error) {
    await deleteFile(stored.storagePath)
    throw error
  }
  return { kind: "done", id }
}

export async function creditSurrenderProceeds(actor: Actor, id: string, saleProceedsCents: number, receivedAt?: Date): Promise<Result> {
  if (!Number.isSafeInteger(saleProceedsCents) || saleProceedsCents <= 0) return { kind: "not_ready", reason: "Sale proceeds must be positive integer cents" }
  return refusable(() => prisma.$transaction(async (tx): Promise<Result> => {
    const head = await tx.surrenderRequest.findFirst({ where: { id, tenantId: actor.tenantId }, select: { loanId: true } })
    if (!head) return { kind: "not_found" }
    await lockLoanForUpdate(tx, head.loanId)
    await tx.$queryRaw`SELECT 1 FROM "SurrenderRequest" WHERE id=${id} FOR UPDATE`
    const request = await tx.surrenderRequest.findFirstOrThrow({ where: { id, tenantId: actor.tenantId }, include: { recovery: true } })
    if (request.recovery) throw new RecoveryRefusal(RECOVERY_HANDLES_PROCEEDS)
    if (request.status !== "VALUATION_NOTICE_ISSUED") throw new RecoveryRefusal("Issue the valuation notice before crediting proceeds")
    const asOf = receivedAt ?? new Date()
    await requireNcaSaleWindow(tx, actor.tenantId, id, "surrender", asOf)
    const loan = await tx.loan.findFirstOrThrow({ where: { id: request.loanId, tenantId: actor.tenantId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    const settlement = await loanSettlementFigures(tx, loan, asOf)
    const inThisTransaction = { $transaction: <T>(run: (client: SigningTx) => Promise<T>) => run(tx) } as unknown as PaymentDb
    const result = await applyManualReceipt(inThisTransaction, {
      loanId: request.loanId, tenantId: actor.tenantId, amount: saleProceedsCents, paymentMethod: "EFT",
      reference: `S127-${id}`, notes: "Voluntary-surrender sale proceeds", capturedById: actor.userId,
      capturedByEmail: actor.userEmail, idempotencyKey: `asset-surrender:${id}:proceeds`, receivedAt: asOf,
    })
    const outcome = surrenderOutcome({ settlementDueCents: settlement.totalToSettle, saleProceedsCents })
    await tx.surrenderRequest.update({ where: { id, tenantId: actor.tenantId }, data: {
      status: "PROCEEDS_CREDITED", saleProceedsCents, proceedsPaymentId: result.payment.id, ...outcome,
    } })
    await syncLoanCharges(tx, { tenantId: actor.tenantId, loanId: request.loanId }, asOf, { source: "surrender_proceeds", userId: actor.userId, userEmail: actor.userEmail })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_SURRENDER_PROCEEDS_CREDITED, entity: "SurrenderRequest", entityId: id,
      newValue: { saleProceedsCents, settlementDueCents: settlement.totalToSettle, paymentId: result.payment.id, ...outcome },
    }, tx)
    return { kind: "done", id }
  }, { timeout: 30_000 }))
}

export async function readSurrenderNotice(tenantId: string, id: string, kind: "valuation" | "final"): Promise<{ bytes: Buffer; sha256: string } | null> {
  const row = await prisma.surrenderRequest.findFirst({ where: { id, tenantId }, select: {
    valuationNoticePath: true, valuationNoticeSha256: true, finalNoticePath: true, finalNoticeSha256: true,
  } })
  const path = kind === "valuation" ? row?.valuationNoticePath : row?.finalNoticePath
  const sha256 = kind === "valuation" ? row?.valuationNoticeSha256 : row?.finalNoticeSha256
  if (!path || !sha256) return null
  return readVerified(path, sha256, "Surrender notice")
}

export async function clientSurrenderAccess(tenantId: string, clientId: string, id: string): Promise<boolean> {
  return (await prisma.surrenderRequest.count({ where: {
    id, tenantId, loan: { OR: [
      { clientId },
      { entity: { relationships: { some: { clientId, active: true, role: { in: ["DIRECTOR", "MEMBER", "TRUSTEE", "AUTHORISED_SIGNATORY"] } } } } },
    ] },
  } })) === 1
}

type NoticeRow = NonNullable<Awaited<ReturnType<typeof loadNoticeData>>>
async function loadNoticeData(tenantId: string, id: string) {
  return prisma.surrenderRequest.findFirst({ where: { id, tenantId }, include: {
    valuation: true,
    loan: { select: { reference: true, client: true, entity: true } },
    asset: true,
    recovery: { select: {
      settlementDueCents: true, grossProceedsCents: true, deductedCostsCents: true, netProceedsCents: true, chargedCostsCents: true, shortfallCents: true, surplusCents: true, unrecoverableCostsCents: true,
      costs: { where: { status: "APPROVED" }, select: { type: true, grossCents: true, treatment: true }, orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }] } } },
  } })
}

async function noticeData(tenantId: string, row: NoticeRow, documentDate: Date): Promise<SurrenderNoticeData> {
  const [lender, approved] = await Promise.all([getLenderIdentity(tenantId), legalWordingApproved(prisma, tenantId)])
  const borrower = row.loan.client ? {
    name: `${row.loan.client.firstName} ${row.loan.client.lastName}`, identityNumber: row.loan.client.idNumber,
    addressLines: [row.loan.client.addressLine1, row.loan.client.city, row.loan.client.province, row.loan.client.postalCode].filter((v): v is string => !!v),
  } : row.loan.entity ? {
    name: row.loan.entity.legalName, identityNumber: row.loan.entity.registrationNumber,
    addressLines: [row.loan.entity.addressLine1, row.loan.entity.addressLine2, row.loan.entity.city, row.loan.entity.province, row.loan.entity.postalCode].filter((v): v is string => !!v),
  } : { name: "Unknown borrower", identityNumber: "Unknown", addressLines: [] }
  return {
    ...((row.refundCents ?? 0) > 0 ? await ncaSurplusNoticeDetails(tenantId, row.loanId) : {}),
    legalWordingApproved: approved, reference: row.loan.reference, documentDate,
    lender: { legalName: lender.legalName, ncrNumber: requireNcrNumber(lender), registeredOfficeLines: lender.registeredOfficeLines }, borrower,
    asset: { description: `${row.asset.year} ${row.asset.make} ${row.asset.model}`, serialNumber: row.asset.vin ?? row.asset.serialNumber, condition: row.assetCondition },
    requestDate: isoOfDbDate(row.requestedOn), valuationDueDate: isoOfDbDate(row.valuationDueOn),
    valuation: row.valuation ? { valuedOn: isoOfDbDate(row.valuation.valuedOn), valuerName: row.valuation.valuerName, amountCents: row.valuation.amountCents } : undefined,
    outcome: row.saleProceedsCents === null || row.shortfallCents === null || row.refundCents === null ? undefined
      : { saleProceedsCents: row.saleProceedsCents, shortfallCents: row.shortfallCents, refundCents: row.refundCents },
    recoveryOutcome: recoveryOutcome(row.recovery),
    costs: row.recovery?.costs.map((c) => ({ type: c.type, label: COST_TYPE_LABELS[c.type], grossCents: c.grossCents, treatment: c.treatment })),
  }
}

function recoveryOutcome(recovery: NoticeRow["recovery"]): SurrenderNoticeData["recoveryOutcome"] {
  if (!recovery || recovery.settlementDueCents === null || recovery.grossProceedsCents === null || recovery.deductedCostsCents === null
    || recovery.netProceedsCents === null || recovery.chargedCostsCents === null || recovery.shortfallCents === null || recovery.surplusCents === null) return undefined
  return {
    settlementDueCents: recovery.settlementDueCents, grossProceedsCents: recovery.grossProceedsCents, deductedCostsCents: recovery.deductedCostsCents,
    netProceedsCents: recovery.netProceedsCents, chargedCostsCents: recovery.chargedCostsCents, shortfallCents: recovery.shortfallCents, surplusCents: recovery.surplusCents,
    unrecoverableCostsCents: recovery.unrecoverableCostsCents ?? undefined,
  }
}
