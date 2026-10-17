import { Prisma } from "@prisma/client"
import { pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { getLenderIdentity } from "@/lib/config/identity"
import { deleteFile, saveFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { sastCalendarDate } from "@/lib/date/sast"
import { renderNcaAssetAgreement } from "./documents/nca/agreement-pdf"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import { dbDate } from "./dates"
import { resolveRate } from "./deal-structure"
import { DEAL_STRUCTURE_SELECT, termsFromDeal } from "./deal-terms"
import { preparedSignerSet } from "./signing"
import { currentRequiredSigners, lockDeal, type PrepareResult, type SigningActor } from "./signing-prepare"

interface Stored { sha256: string; storagePath: string }
const key = (s: { clientId: string; document: string }) => s.document === "SURETYSHIP" ? `${s.document}:${s.clientId}` : s.document

/** Prepare the entity-NCA agreement plus the entity authority documents. */
export async function prepareEntityNcaDocuments(actor: SigningActor, dealId: string): Promise<PrepareResult> {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId: actor.tenantId }, select: {
    id: true, status: true, entityId: true, contractType: true, decidedAt: true,
    ...DEAL_STRUCTURE_SELECT,
    application: { select: {
      id: true, reference: true, status: true, ncaRegime: true, ncaRepresentativeClientId: true,
      pasqEvidence: true, pasqDocumentSha256: true, pasqAcknowledgedSha256: true,
    } },
    entity: true,
    asset: true,
  } })
  if (!deal) return { kind: "not_found" }
  if (deal.status !== "APPROVED") return { kind: "not_approved", status: deal.status }
  if (!deal.entityId || !deal.entity || deal.application.ncaRegime !== "NCA") return { kind: "no_authority" }
  if (deal.contractType !== "INSTALMENT_SALE" && deal.contractType !== "FINANCE_LEASE") return { kind: "no_authority" }
  const entityId = deal.entityId
  const representative = deal.application.ncaRepresentativeClientId
  if (!representative || deal.application.pasqAcknowledgedSha256 !== deal.application.pasqDocumentSha256 || !pasqEvidenceIsIntact(deal.application.pasqEvidence)) {
    return { kind: "no_authority" }
  }
  const evidence = deal.application.pasqEvidence
  const startDate = sastCalendarDate(new Date(evidence.calculator.startDate))
  const rate = await resolveRate(prisma, actor.tenantId, termsFromDeal(deal).rate, startDate)
  if ("error" in rate) return { kind: "invalid_start", error: rate.error }
  const [lender, authorityData] = await Promise.all([
    getLenderIdentity(actor.tenantId),
    loadDealDocumentData(prisma, actor.tenantId, dealId, { plannedStartDate: startDate, useAcknowledgedNcaTerms: true }),
  ])
  if (!authorityData) return { kind: "not_found" }
  const ncaAuthorityData = {
    ...authorityData,
    pricing: {
      ...authorityData.pricing,
      financedFeesCents: evidence.calculator.initiationFeeCents,
      financedAmountCents: evidence.calculator.principalCents,
      baseInstalmentCents: evidence.calculator.recurringInstalmentCents,
      totalInterestCents: evidence.calculator.totalInterestCents,
      totalPayableCents: evidence.billing.totalRepayableCents,
      annualRate: rate.annualRate,
      startDate,
      arrearsMarginRate: null,
      collectionFeeCents: 0,
    },
    schedule: evidence.billing.schedule.map((r, index) => ({
      index, dueDate: r.dueDate.slice(0, 10), weight: 1,
      openingBalanceCents: r.openingBalanceCents, interestCents: r.interestDueCents,
      principalCents: r.principalDueCents, feesCents: r.feesDueCents,
      balloonCents: index === evidence.billing.schedule.length - 1 ? deal.balloonCents : 0,
      totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  }
  const required = ncaAuthorityData.requiredSigners
  if (!required.some((s) => s.clientId === representative && s.document === "AGREEMENT")) return { kind: "no_authority" }
  const agreement = await renderNcaAssetAgreement({
    legalWordingApproved: authorityData.legalWordingApproved, reference: deal.application.reference, documentDate: deal.decidedAt ?? new Date(), contractType: deal.contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: {
      name: deal.entity.legalName, identityNumber: deal.entity.mastersReference ?? deal.entity.registrationNumber,
      addressLines: [deal.entity.addressLine1, deal.entity.addressLine2, deal.entity.city, deal.entity.province, deal.entity.postalCode].filter((v): v is string => !!v),
    },
    asset: { description: `${deal.asset.year} ${deal.asset.make} ${deal.asset.model}`, serialNumber: deal.asset.vin ?? deal.asset.serialNumber },
    pricing: {
      cashPriceCents: deal.asset.cashPriceExclVatCents + deal.asset.vatCents, depositCents: deal.depositCents,
      principalCents: evidence.calculator.principalCents, annualRate: rate.annualRate,
      rateBasis: deal.rateBasis, rateMargin: deal.rateMargin?.toString() ?? null, reference: rate.reference,
      initiationFeeCents: evidence.calculator.initiationFeeCents,
      monthlyServiceFeeCents: Math.round(evidence.calculator.serviceFeesCents / evidence.calculator.schedule.length),
      creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents, instalmentCents: evidence.billing.recurringPaymentCents,
      balloonCents: deal.balloonCents, totalInterestCents: evidence.calculator.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    schedule: evidence.billing.schedule.map((r) => ({
      installmentNo: r.installmentNo, dueDate: r.dueDate.slice(0, 10), principalCents: r.principalDueCents,
      interestCents: r.interestDueCents, feesCents: r.feesDueCents, totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  })
  const stored = new Map<string, Stored>()
  try {
    for (const signer of required) {
      const documentKey = key(signer)
      if (stored.has(documentKey)) continue
      const rendered = signer.document === "AGREEMENT"
        ? { bytes: agreement, sha256: sha256DocumentBytes(agreement) }
        : await renderDealDocument(ncaAuthorityData, signer.document, signer.clientId)
      const file = await saveFile(rendered.bytes, "application/pdf")
      stored.set(documentKey, { sha256: rendered.sha256, storagePath: file.storagePath })
    }
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await lockDeal(tx, actor.tenantId, dealId)
      if (!locked) return { result: { kind: "not_found" } as const, released: [] as string[] }
      if (locked.status !== "APPROVED") return { result: { kind: "not_approved", status: locked.status } as const, released: [] as string[] }
      const now = await currentRequiredSigners(tx, actor.tenantId, entityId)
      if (now.map(key).join("|") !== required.map(key).join("|")) return { result: { kind: "people_changed" } as const, released: [] as string[] }
      const existing = await tx.dealSigner.findMany({ where: { tenantId: actor.tenantId, dealId }, select: { id: true, method: true, documentStoragePath: true } })
      if (existing.some((row) => row.method !== null)) return { result: { kind: "signing_started" } as const, released: [] as string[] }
      await tx.dealSigner.deleteMany({ where: { tenantId: actor.tenantId, dealId } })
      let representativeSigner: { id: string; sha256: string } | null = null
      for (const signer of now) {
        const document = stored.get(key(signer))
        if (!document) throw new Error("Entity NCA signing document was not rendered")
        const row = await tx.dealSigner.create({ data: {
          tenantId: actor.tenantId, dealId, clientId: signer.clientId, role: signer.role, document: signer.document,
          documentSha256: document.sha256, documentStoragePath: document.storagePath,
        } })
        if (signer.clientId === representative && signer.document === "AGREEMENT") representativeSigner = { id: row.id, sha256: document.sha256 }
      }
      if (!representativeSigner) throw new Error("Entity NCA representative agreement signer was not created")
      await tx.assetFinanceDeal.update({ where: { id: dealId, tenantId: actor.tenantId }, data: {
        plannedStartDate: dbDate(startDate), signedBaseInstalmentCents: evidence.calculator.recurringInstalmentCents,
        signedResultingRate: new Prisma.Decimal(rate.annualRate), signedTotalInterestCents: evidence.calculator.totalInterestCents,
        signedArrearsMarginRate: null, signedCollectionFeeCents: 0, preparedSigners: preparedSignerSet(now),
      } })
      await tx.loanApplication.update({ where: { id: deal.application.id, tenantId: actor.tenantId }, data: {
        agreementGeneratedAt: new Date(), agreementDocumentId: representativeSigner.id,
        agreementDocumentSha256: representativeSigner.sha256,
      } })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
        action: AuditAction.ASSET_DEAL_DOCUMENTS_PREPARED, entity: "AssetFinanceDeal", entityId: dealId,
        newValue: { ncaRegime: "NCA", representativeClientId: representative, signers: now.length, agreementSha256: representativeSigner.sha256, draftLegalWording: !authorityData.legalWordingApproved },
      }, tx)
      return { result: { kind: "prepared", signers: now.length } as const, released: existing.map((r) => r.documentStoragePath).filter((p): p is string => !!p) }
    })
    const kept = outcome.result.kind === "prepared" ? new Set([...stored.values()].map((d) => d.storagePath)) : new Set<string>()
    await Promise.all([...outcome.released, ...[...stored.values()].map((d) => d.storagePath)].filter((p) => !kept.has(p)).map((p) => deleteFile(p)))
    return outcome.result
  } catch (error) {
    await Promise.all([...stored.values()].map((d) => deleteFile(d.storagePath)))
    throw error
  }
}
