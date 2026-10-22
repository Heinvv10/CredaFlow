import { Prisma } from "@prisma/client"
import { pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { getLenderIdentity } from "@/lib/config/identity"
import { deleteFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { renderNcaAssetAgreement } from "./documents/nca/agreement-pdf"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import type { NcaAssetDocumentData } from "./documents/nca/types"
import { dealerPrintRefusal } from "./documents/wording/dealer-name"
import {
  issuedWording, lockSelectedTemplate, ncaQuoteMarkProblem, ncaTemplateKey, TemplateNotIssuableError, recordIssuance, selectIssuableTemplate, storeIssuanceFiles, supersedeIssuances, templateKeyFor,
  type PreparedIssuance, type SelectedTemplate,
} from "./documents/templates/issuance"
import { dbDate } from "./dates"
import { resolveRate } from "./deal-structure"
import { DEAL_STRUCTURE_SELECT, termsFromDeal } from "./deal-terms"
import { preparedSignerSet } from "./signing"
import { currentRequiredSigners, lockDeal, type PrepareResult, type SigningActor } from "./signing-prepare"

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
    dealer: { select: { name: true } },
  } })
  if (!deal) return { kind: "not_found" }
  if (deal.status !== "APPROVED") return { kind: "not_approved", status: deal.status }
  const dealerRefusal = deal.dealer && dealerPrintRefusal(deal.dealer.name)
  if (dealerRefusal) return { kind: "invalid_start", error: dealerRefusal }
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
      index, dueDate: sastCalendarDate(new Date(r.dueDate)), weight: 1,
      openingBalanceCents: r.openingBalanceCents, interestCents: r.interestDueCents,
      principalCents: r.principalDueCents, feesCents: r.feesDueCents,
      balloonCents: index === evidence.billing.schedule.length - 1 ? deal.balloonCents : 0,
      totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  }
  const required = ncaAuthorityData.requiredSigners
  if (!required.some((s) => s.clientId === representative && s.document === "AGREEMENT")) return { kind: "no_authority" }
  const ncaData: NcaAssetDocumentData = {
    legalWordingApproved: authorityData.legalWordingApproved, reference: deal.application.reference, documentDate: deal.decidedAt ?? new Date(), contractType: deal.contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: {
      name: deal.entity.legalName, identityNumber: deal.entity.mastersReference ?? deal.entity.registrationNumber,
      addressLines: [deal.entity.addressLine1, deal.entity.addressLine2, deal.entity.city, deal.entity.province, deal.entity.postalCode].filter((v): v is string => !!v),
    },
    asset: { description: `${deal.asset.year} ${deal.asset.make} ${deal.asset.model}`, serialNumber: deal.asset.vin ?? deal.asset.serialNumber },
    dealer: deal.dealer ? { name: deal.dealer.name } : null,
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
      installmentNo: r.installmentNo, dueDate: sastCalendarDate(new Date(r.dueDate)), principalCents: r.principalDueCents,
      interestCents: r.interestDueCents, feesCents: r.feesDueCents, totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  }
  // Each document is the lender's published, approved template version
  // (documents/templates/issuance.ts); a missing one throws TemplateNotIssuableError.
  const stored = new Map<string, PreparedIssuance>()
  const files = (d: PreparedIssuance) => [d.pdfStoragePath, d.inputStoragePath]
  try {
    const selected = new Map<string, SelectedTemplate>()
    const template = async (templateKey: string) => {
      const found = selected.get(templateKey) ?? await selectIssuableTemplate(prisma, actor.tenantId, templateKey)
      selected.set(templateKey, found)
      return found
    }
    for (const signer of required) {
      const documentKey = key(signer)
      if (stored.has(documentKey)) continue
      if (signer.document === "AGREEMENT") {
        const chosen = await template(ncaTemplateKey(deal.contractType))
        const quoteProblem = await ncaQuoteMarkProblem(prisma, actor.tenantId, dealId, deal.application.pasqDocumentSha256, chosen)
        if (quoteProblem) throw new TemplateNotIssuableError(quoteProblem)
        const bytes = await renderNcaAssetAgreement(ncaData, issuedWording(chosen))
        stored.set(documentKey, await storeIssuanceFiles(chosen, { kind: "nca", document: "AGREEMENT", clientId: signer.clientId, data: ncaData }, bytes))
      } else {
        const chosen = await template(templateKeyFor(ncaAuthorityData, signer.document))
        const rendered = await renderDealDocument(ncaAuthorityData, signer.document, signer.clientId, issuedWording(chosen))
        stored.set(documentKey, await storeIssuanceFiles(chosen, { kind: "deal", document: signer.document, clientId: signer.clientId, data: ncaAuthorityData }, rendered.bytes))
      }
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
      for (const doc of stored.values()) await lockSelectedTemplate(tx, actor.tenantId, doc.selected)
      const supersededFiles = await supersedeIssuances(tx, actor.tenantId, dealId, new Date())
      const issuances = new Map<string, string>()
      for (const [documentKey, doc] of stored) issuances.set(documentKey, await recordIssuance(tx, actor.tenantId, dealId, actor.userId, doc))
      let representativeSigner: { id: string; sha256: string } | null = null
      for (const signer of now) {
        const document = stored.get(key(signer))
        if (!document) throw new Error("Entity NCA signing document was not rendered")
        const row = await tx.dealSigner.create({ data: {
          tenantId: actor.tenantId, dealId, clientId: signer.clientId, role: signer.role, document: signer.document,
          documentSha256: document.pdfSha256, documentStoragePath: document.pdfStoragePath, issuanceId: issuances.get(key(signer))!,
        } })
        if (signer.clientId === representative && signer.document === "AGREEMENT") representativeSigner = { id: row.id, sha256: document.pdfSha256 }
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
        newValue: {
          ncaRegime: "NCA", representativeClientId: representative, signers: now.length, agreementSha256: representativeSigner.sha256,
          templates: [...stored.entries()].map(([documentKey, d]) => ({
            document: documentKey, issuanceId: issuances.get(documentKey), templateKey: d.selected.templateKey,
            templateVersion: d.selected.versionNumber, approvalBasis: d.selected.approvalBasis, pdfSha256: d.pdfSha256,
          })),
        },
      }, tx)
      return { result: { kind: "prepared", signers: now.length } as const, released: [...existing.map((r) => r.documentStoragePath).filter((p): p is string => !!p), ...supersededFiles] }
    })
    const kept = outcome.result.kind === "prepared" ? new Set([...stored.values()].flatMap(files)) : new Set<string>()
    await Promise.all([...new Set([...outcome.released, ...[...stored.values()].flatMap(files)])].filter((p) => !kept.has(p)).map((p) => deleteFile(p)))
    return outcome.result
  } catch (error) {
    await Promise.all([...stored.values()].flatMap(files).map((p) => deleteFile(p)))
    throw error
  }
}
