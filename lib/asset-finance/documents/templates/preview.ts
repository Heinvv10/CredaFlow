// A template preview: the lender's own identity and a clearly synthetic,
// server-built deal of the template's variant, rendered by the same trusted
// renderers issuance uses, always with the DRAFT mark. A preview is never
// issued, stored or signable.
//
// Each variant has a fixed set of deal SHAPES that between them reach every
// branch of its protected wording (entity types, rate bases, balloon and
// arrears terms, lease timing, maintenance risk and lessee kind, NCA size).
// The approver can preview each, and the protected-output fingerprint
// (./fingerprint.ts) covers all of them. Figures in a shape other than the
// first are illustrative. Every variant that prints the dealer commission
// disclosure (wording/commission-disclosure.ts) has a "dealer" shape, so that
// paragraph is fingerprinted; the other shapes are dealer-less.
import type { LenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { leaseScheduleView } from "../../lease-view"
import { priceLease } from "../../lease-pricing"
import { createAssetPasqEvidence } from "../../nca-evidence"
import { solveNcaDealStructure } from "../../nca-structure"
import type { AnyDealDocumentData, DealDocumentData } from "../deal-document-data"
import type { LeaseDocumentTerms } from "../lease/lease-document-data"
import { renderNcaAssetAgreement } from "../nca/agreement-pdf"
import type { NcaAssetDocumentData } from "../nca/types"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal"
import type { AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"

type PreviewLender = Pick<LenderIdentity, "legalName" | "tradingName" | "companyRegNumber" | "ncrNumber" | "registeredOfficeLines">

export interface PreviewShape {
  id: string
  label: string
}

type DealShape = PreviewShape & { deal: (base: DealDocumentData) => AnyDealDocumentData }
type NcaShape = PreviewShape & { nca: (base: NcaAssetDocumentData) => NcaAssetDocumentData }

function leaseTerms(
  contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE",
  cpa: boolean,
  opts: { advance?: boolean; riskModel?: "LESSEE_SETTLED" | "LENDER_RISK"; usage?: boolean; km?: boolean; flat?: boolean } = {},
): LeaseDocumentTerms {
  const fml = contractType === "FULL_MAINTENANCE_LEASE"
  const timing = opts.advance ? "ADVANCE" : "ARREARS"
  const usage = opts.usage ?? fml
  // flat: no rental or maintenance escalation and no early-termination penalty.
  const escalation = opts.flat ? "0" : "0.08"
  const maintenanceEscalation = opts.flat ? "0" : "0.065"
  const priced = priceLease({
    cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: timing, escalationRate: escalation,
    startDate: opts.advance ? "2027-01-31" : "2026-12-31", firstDueDate: "2027-01-31",
    ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
    maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: maintenanceEscalation } : null, vatRateTenThousandths: 1500,
  })
  return {
    contractType,
    terms: {
      rentalTiming: timing, escalationRate: escalation, earlyTerminationPenaltyRate: opts.flat ? "0" : "0.1",
      maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: maintenanceEscalation, riskModel: opts.riskModel ?? "LESSEE_SETTLED" } : null,
      usage: usage ? (opts.km ? { allowancePerYear: 60_000, unit: "KM", excessRateCents: 450 } : { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 }) : null,
    },
    schedule: leaseScheduleView(priced, "0.1500"), endDate: "2029-12-31",
    cpaApplies: cpa, cpaRule: cpa ? "CPA_JURISTIC_UNDER_THRESHOLD" : "CPA_JURISTIC_OVER_THRESHOLD",
  }
}

function ncaBase(lender: PreviewLender, contractType: "INSTALMENT_SALE" | "FINANCE_LEASE"): NcaAssetDocumentData {
  const asset = { cashPriceExclVatCents: 100_000_000, vatCents: 15_000_000 }
  const terms = {
    depositCents: 15_000_000, tradeInCents: 0, financedFeesCents: 120_750, balloonCents: 20_000_000, preset: "MONTHLY" as const,
    weights: Array.from({ length: 36 }, () => 1), firstDueDate: "2027-01-31", vatDeferralPeriodIndex: null,
    rate: { basis: "PRIME" as const, fixedRate: null, margin: "0.0125" },
  }
  const rate = { annualRate: "0.1175", reference: { effectiveDate: "2026-09-01", rate: "0.105" } }
  const solved = solveNcaDealStructure(asset, terms, rate, "2026-12-31")
  if (!solved.ok) throw new Error(solved.error)
  const noOffer = { version: "credit-life-no-offer-v1" as const, election: "DECLINED" as const, principalCents: solved.result.financedAmountCents, termDays: solved.termDays }
  const evidence = createAssetPasqEvidence({
    tenantId: "preview", applicationId: "preview", clientId: "preview", productId: "preview", termDays: solved.termDays,
    generatedAt: new Date("2026-12-31T08:00:00.000Z"), solved, initiationFeeCents: terms.financedFeesCents,
    creditLife: { ...noOffer, offered: false, productId: null, productName: null, insurerId: null, insurerName: null, monthlyPremiumCents: 0, disclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer) },
  })
  const c = evidence.calculator
  return {
    legalWordingApproved: false, reference: "PREVIEW-NCA-0001", documentDate: new Date("2026-12-31T08:00:00.000Z"), contractType,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    borrower: { name: "SAMPLE Consumer (synthetic)", identityNumber: "0000000000000", addressLines: ["1 Sample Street", "Sampletown", "0000"] },
    asset: { description: "2026 SAMPLE Loader (synthetic)", serialNumber: "SAMPLESERIAL0001" },
    pricing: {
      cashPriceCents: asset.cashPriceExclVatCents + asset.vatCents, depositCents: terms.depositCents, principalCents: c.principalCents, annualRate: rate.annualRate,
      rateBasis: "PRIME", rateMargin: "0.0125", reference: rate.reference, initiationFeeCents: c.initiationFeeCents,
      monthlyServiceFeeCents: Math.round(c.serviceFeesCents / c.schedule.length), creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents,
      instalmentCents: evidence.billing.recurringPaymentCents, balloonCents: terms.balloonCents, totalInterestCents: c.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    schedule: evidence.billing.schedule.map((r) => ({
      installmentNo: r.installmentNo, dueDate: sastCalendarDate(new Date(r.dueDate)), principalCents: r.principalDueCents,
      interestCents: r.interestDueCents, feesCents: r.feesDueCents, totalCents: r.totalDueCents, closingBalanceCents: r.closingBalanceCents,
    })),
  }
}

const SAMPLE_DEALER = { name: "SAMPLE Dealer (synthetic)" }

type Entity = DealDocumentData["entity"]
const ENTITIES: Record<"COMPANY" | "TRUST" | "CC" | "PARTNERSHIP", Partial<Entity>> = {
  COMPANY: {},
  TRUST: { type: "TRUST", legalName: "SAMPLE Family Trust", registrationNumber: "IT0000/2099", mastersReference: "IT0000/2099", tradingName: null },
  CC: { type: "CC", legalName: "SAMPLE Haulage CC", registrationNumber: "2099/000003/23" },
  PARTNERSHIP: { type: "PARTNERSHIP", legalName: "SAMPLE Partners", registrationNumber: "PARTNERSHIP-0001", vatNumber: null },
}
const entity = (d: DealDocumentData, type: keyof typeof ENTITIES): DealDocumentData => ({ ...d, entity: { ...d.entity, ...ENTITIES[type] } })
const rate = (d: DealDocumentData, basis: DealDocumentData["pricing"]["rateBasis"]): DealDocumentData => ({
  ...d, pricing: basis === "FIXED"
    ? { ...d.pricing, rateBasis: "FIXED", rateMargin: null, fixedRate: d.pricing.annualRate, reference: null }
    : { ...d.pricing, rateBasis: basis },
})
const plain = (d: DealDocumentData): DealDocumentData => ({ ...d, pricing: { ...d.pricing, balloonCents: 0, arrearsMarginRate: null, collectionFeeCents: 0 } })
const sole = (d: DealDocumentData, lease: LeaseDocumentTerms): AnyDealDocumentData => ({
  ...d, entity: null, lease,
  soleProprietor: { clientId: "client-lessee", name: "SAMPLE Sole Proprietor", idNumber: "0000000000000", addressLines: ["3 Sample Lane", "Sampletown"] },
  signatories: [{ clientId: "client-lessee", name: "SAMPLE Sole Proprietor", idNumber: "0000000000000" }], sureties: [],
})

function isaShapes(cpa: boolean): DealShape[] {
  const v = (d: DealDocumentData) => ({ ...d, isaCpaApplies: cpa })
  return [
    { id: "prime-company", label: "Company, prime-linked, balloon and arrears terms", deal: v },
    { id: "fixed-trust", label: "Trust, fixed rate, no balloon or arrears terms", deal: (d) => v(plain(rate(entity(d, "TRUST"), "FIXED"))) },
    { id: "zaronia-cc", label: "Close corporation, ZARONIA-linked", deal: (d) => v(rate(entity(d, "CC"), "ZARONIA")) },
    { id: "repo-partnership", label: "Partnership, repo-linked", deal: (d) => v(rate(entity(d, "PARTNERSHIP"), "REPO")) },
    { id: "jibar", label: "JIBAR-linked", deal: (d) => v(rate(d, "JIBAR")) },
    { id: "lender-base", label: "Linked to the lender's base rate", deal: (d) => v(rate(d, "LENDER_BASE")) },
    { id: "below-reference", label: "Margin below the reference rate, default interest at the contract rate, purchaser address not recorded", deal: (d) => v({ ...d, entity: { ...d.entity, addressLines: [] }, pricing: { ...d.pricing, rateMargin: "-0.005", arrearsMarginRate: "0" } }) },
    { id: "dealer", label: "Dealer deal: commission disclosure", deal: (d) => v({ ...d, dealer: SAMPLE_DEALER }) },
  ]
}

function leaseShapes(contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE", cpa: boolean): DealShape[] {
  const fml = contractType === "FULL_MAINTENANCE_LEASE"
  const l = (d: DealDocumentData, opts?: Parameters<typeof leaseTerms>[2]) => ({ ...d, lease: leaseTerms(contractType, cpa, opts) })
  const shapes: DealShape[] = [
    { id: "juristic-arrears", label: "Company lessee, rentals in arrears", deal: (d) => l(d) },
    { id: "juristic-advance", label: "Company lessee, rentals in advance", deal: (d) => l(d, { advance: true }) },
    { id: "fixed", label: "Fixed rate, default interest at the contract rate (no added margin)", deal: (d) => { const f = rate(d, "FIXED"); return l({ ...f, pricing: { ...f.pricing, arrearsMarginRate: "0" } }) } },
    ...(["REPO", "JIBAR", "ZARONIA", "LENDER_BASE"] as const).map((basis): DealShape => ({
      id: `rate-${basis.toLowerCase()}`, label: `Linked to ${basis === "LENDER_BASE" ? "the lender's base rate" : basis}`, deal: (d) => l(rate(d, basis)),
    })),
    { id: "flat-km-plain", label: "Usage in km, no escalation or early-termination penalty, no default interest or collection fee", deal: (d) => l(plain(d), { usage: true, km: true, flat: true }) },
    fml
      ? { id: "lender-risk", label: "Maintenance risk with the lessor", deal: (d) => l(d, { riskModel: "LENDER_RISK" }) }
      : { id: "with-usage", label: "Contracted usage", deal: (d) => l(d, { usage: true }) },
    { id: "dealer", label: "Dealer deal: commission disclosure", deal: (d) => l({ ...d, dealer: SAMPLE_DEALER }) },
  ]
  // Only a natural-person lessee brings CPA s14 by statute: the CPA variants also cover a sole proprietor.
  if (cpa) shapes.push({ id: "sole-proprietor", label: "Sole proprietor lessee", deal: (d) => sole(d, leaseTerms(contractType, true)) })
  return shapes
}

function suretyshipShapes(nca: boolean): DealShape[] {
  const v = (d: DealDocumentData) => ({ ...d, ncaApplies: nca })
  return [
    { id: "surety-with-address", label: "Surety with a recorded address", deal: v },
    { id: "surety-without-address", label: "Surety without an address", deal: (d) => v({ ...d, sureties: [{ clientId: "client-surety", name: "SAMPLE Surety", idNumber: "0000000000002" }] }) },
  ]
}

function resolutionShapes(): DealShape[] {
  const two = (d: DealDocumentData): DealDocumentData => ({ ...d, signatories: [...d.signatories, { clientId: "client-second", name: "SAMPLE Second Signatory", idNumber: "0000000000003" }] })
  return [
    { id: "company", label: "Company, one signatory", deal: (d) => d },
    { id: "company-two", label: "Company, two signatories", deal: two },
    { id: "trust", label: "Trust", deal: (d) => entity(d, "TRUST") },
    { id: "cc", label: "Close corporation", deal: (d) => entity(d, "CC") },
    { id: "partnership", label: "Partnership", deal: (d) => entity(d, "PARTNERSHIP") },
  ]
}

const NCA_SHAPES: NcaShape[] = [
  { id: "prime-intermediate", label: "Prime-linked, intermediate agreement, residual", nca: (d) => d },
  { id: "fixed", label: "Fixed rate", nca: (d) => ({ ...d, pricing: { ...d.pricing, rateBasis: "FIXED", rateMargin: null, reference: null } }) },
  { id: "small-no-residual", label: "Small agreement, no residual (illustrative figures)", nca: (d) => ({ ...d, pricing: { ...d.pricing, principalCents: 1_000_000, balloonCents: 0 } }) },
  { id: "large", label: "Large agreement (illustrative figures)", nca: (d) => ({ ...d, pricing: { ...d.pricing, principalCents: 30_000_000 } }) },
  { id: "credit-life", label: "Credit life elected (illustrative premium)", nca: (d) => ({ ...d, pricing: { ...d.pricing, creditLifePremiumCents: 12_345 } }) },
  ...(["REPO", "JIBAR", "ZARONIA", "LENDER_BASE"] as const).map((basis): NcaShape => ({
    id: `rate-${basis.toLowerCase()}`, label: `Linked to ${basis === "LENDER_BASE" ? "the lender's base rate" : basis}`, nca: (d) => ({ ...d, pricing: { ...d.pricing, rateBasis: basis } }),
  })),
  { id: "dealer", label: "Dealer deal: commission disclosure", nca: (d) => ({ ...d, dealer: SAMPLE_DEALER }) },
]

function dealShapes(templateKey: string): DealShape[] {
  switch (templateKey) {
    case "af.isa.commercial": return isaShapes(false)
    case "af.isa.cpa": return isaShapes(true)
    case "af.lease.operating.commercial": return leaseShapes("OPERATING_LEASE", false)
    case "af.lease.operating.cpa": return leaseShapes("OPERATING_LEASE", true)
    case "af.lease.fml.commercial": return leaseShapes("FULL_MAINTENANCE_LEASE", false)
    case "af.lease.fml.cpa": return leaseShapes("FULL_MAINTENANCE_LEASE", true)
    case "af.suretyship.nca": return suretyshipShapes(true)
    case "af.suretyship.commercial": return suretyshipShapes(false)
    case "af.resolution.standard": return resolutionShapes()
    default: return []
  }
}

/** The deal shapes a variant previews and fingerprints, in order (the first is the default preview). */
export function previewShapes(templateKey: string): PreviewShape[] {
  const key = parseTemplateKey(templateKey)
  if (!key) throw new RangeError(`Not an asset-finance template: ${templateKey}`)
  const shapes: PreviewShape[] = key.family.family === "af.nca" ? NCA_SHAPES : dealShapes(templateKey)
  return shapes.map(({ id, label }) => ({ id, label }))
}

/** The preview PDF of `content` for template `templateKey` under `lender`'s identity, in deal shape `shapeId` (default the first). */
export async function renderTemplatePreview(templateKey: string, content: AssetTemplateContent, lender: PreviewLender, shapeId?: string): Promise<Buffer> {
  const key = parseTemplateKey(templateKey)
  if (!key) throw new RangeError(`Not an asset-finance template: ${templateKey}`)
  const wording = { templateKey, content, mark: "DRAFT" as const }
  if (key.family.family === "af.nca") {
    const shape = shapeId === undefined ? NCA_SHAPES[0] : NCA_SHAPES.find((s) => s.id === shapeId)
    if (!shape) throw new RangeError(`Unknown preview shape ${shapeId} for ${templateKey}`)
    return renderNcaAssetAgreement(shape.nca(ncaBase(lender, key.variant === "finance_lease" ? "FINANCE_LEASE" : "INSTALMENT_SALE")), wording)
  }
  const shapes = dealShapes(templateKey)
  const shape = shapeId === undefined ? shapes[0] : shapes.find((s) => s.id === shapeId)
  if (!shape) throw new RangeError(`Unknown preview shape ${shapeId} for ${templateKey}`)
  const data = shape.deal(syntheticDealDocumentData({ reference: "PREVIEW-0001", lender }))
  const surety = data.entity ? data.sureties.at(-1)?.clientId ?? "" : ""
  return (await renderDealDocument(data, key.family.document, surety, wording)).bytes
}
