// Renders the NCA asset-finance legal-wording samples (DRAFT watermark) to
// docs/asset-finance/evidence/legal-wording/nca/. The agreement and quotation
// figures come from the real solver (solveNcaDealStructure) and PASQ evidence
// builder (createAssetPasqEvidence), mapped as nca-agreement-store.ts maps them,
// and the script refuses to write if they do not agree with each other.
// Deterministic: rerunning reproduces the committed bytes.
//
//   npx tsx scripts/asset-finance/render-legal-wording-nca-samples.ts
//   (needs lib/registry/generated, which is gitignored: run `npm run gen:registries` first)
import { sastCalendarDate } from "@/lib/date/sast"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { solveNcaDealStructure } from "@/lib/asset-finance/nca-structure"
import { createAssetPasqEvidence } from "@/lib/asset-finance/nca-evidence"
import { renderNcaAssetAgreement } from "@/lib/asset-finance/documents/nca/agreement-pdf"
import { renderNcaAssetQuote } from "@/lib/asset-finance/documents/nca/quote-pdf"
import { renderSurrenderFinalNotice, renderSurrenderValuationNotice, type SurrenderNoticeData } from "@/lib/asset-finance/documents/nca/surrender-pdf"
import { renderRecoveryFinalNotice, renderRecoveryValuationNotice, type RecoveryNoticeData } from "@/lib/asset-finance/documents/nca/recovery-pdf"
import type { NcaAssetDocumentData } from "@/lib/asset-finance/documents/nca/types"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const OUT = join(process.cwd(), "docs/asset-finance/evidence/legal-wording/nca")
const asset = { cashPriceExclVatCents: 100_000_000, vatCents: 15_000_000 }
const terms = {
  depositCents: 15_000_000, tradeInCents: 0, financedFeesCents: 120_750, balloonCents: 20_000_000, preset: "MONTHLY" as const,
  weights: Array.from({ length: 36 }, () => 1), firstDueDate: "2027-01-31", vatDeferralPeriodIndex: null,
  rate: { basis: "PRIME" as const, fixedRate: null, margin: "0.0125" },
}
const rate = { annualRate: "0.1175", reference: { effectiveDate: "2026-09-01", rate: "0.105" } }

async function main(): Promise<void> {
  const solved = solveNcaDealStructure(asset, terms, rate, "2026-12-31")
  if (!solved.ok) throw new Error(solved.error)
  const noOffer = { version: "credit-life-no-offer-v1" as const, election: "DECLINED" as const, principalCents: solved.result.financedAmountCents, termDays: solved.termDays }
  const evidence = createAssetPasqEvidence({
    tenantId: "tenant-test", applicationId: "app-test", clientId: "client-test", productId: "product-test", termDays: solved.termDays,
    generatedAt: new Date("2026-12-31T08:00:00.000Z"), solved, initiationFeeCents: terms.financedFeesCents,
    creditLife: { ...noOffer, offered: false, productId: null, productName: null, insurerId: null, insurerName: null, monthlyPremiumCents: 0, disclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer) },
  })
  const c = evidence.calculator
  const data: NcaAssetDocumentData = {
    legalWordingApproved: false, reference: "AF-NCA-SAMPLE-1", documentDate: new Date("2026-12-31T08:00:00.000Z"), contractType: "INSTALMENT_SALE",
    lender: { legalName: "TEST Credit Provider (Pty) Ltd", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road", "Johannesburg", "2000"] },
    borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg", "2001"] },
    asset: { description: "2026 TEST TLB 4x4", serialNumber: "TESTSERIAL0001" },
    pricing: {
      cashPriceCents: asset.cashPriceExclVatCents + asset.vatCents, depositCents: terms.depositCents, principalCents: c.principalCents, annualRate: rate.annualRate,
      rateBasis: "PRIME", rateMargin: "0.0125", reference: rate.reference, initiationFeeCents: c.initiationFeeCents,
      monthlyServiceFeeCents: Math.round(c.serviceFeesCents / c.schedule.length), creditLifePremiumCents: evidence.creditLife.monthlyPremiumCents,
      instalmentCents: evidence.billing.recurringPaymentCents, balloonCents: terms.balloonCents, totalInterestCents: c.totalInterestCents,
      totalCostOfCreditCents: evidence.totalCostOfCreditCents, totalRepayableCents: evidence.billing.totalRepayableCents,
    },
    // Use the same acknowledged PASQ billing rows as the document stores.
    schedule: evidence.billing.schedule.map((r) => ({
      installmentNo: r.installmentNo, dueDate: sastCalendarDate(new Date(r.dueDate)), principalCents: r.principalDueCents,
      interestCents: r.interestDueCents, feesCents: r.feesDueCents, totalCents: r.totalDueCents,
      closingBalanceCents: r.closingBalanceCents,
    })),
  }
  assert.equal(data.schedule[0].dueDate, terms.firstDueDate, "PASQ document due date is the SAST contract date")
  // Internal consistency the samples must show: capital repays the principal; totals add up.
  assert.equal(data.schedule.reduce((s, r) => s + r.principalCents, 0), c.principalCents, "capital rows repay the principal")
  assert.equal(c.principalCents, data.pricing.cashPriceCents - data.pricing.depositCents, "principal = cash price - deposit")
  assert.equal(data.schedule.reduce((s, r) => s + r.totalCents, 0), data.pricing.totalRepayableCents, "rows add up to the total repayable")
  for (const r of data.schedule) assert.equal(r.principalCents + r.interestCents + r.feesCents, r.totalCents, `row ${r.installmentNo} adds up`)
  assert.equal(data.pricing.totalRepayableCents, c.principalCents + c.totalInterestCents + c.initiationFeeCents + c.serviceFeesCents, "total = principal + interest + fees")
  writeFileSync(`${OUT}/quote.pdf`, await renderNcaAssetQuote(data))
  writeFileSync(`${OUT}/agreement-instalment-sale.pdf`, await renderNcaAssetAgreement(data))

  const base = { legalWordingApproved: false, documentDate: new Date("2026-10-13T08:00:00.000Z"),
    lender: { legalName: "TEST Credit Provider", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
    borrower: { name: "TEST Borrower", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street"] } }
  const surrender: SurrenderNoticeData = { ...base, reference: "AF-NCA-S127-TEST",
    asset: { description: "2026 TEST TLB", serialNumber: "TEST-SERIAL-127", condition: "Synthetic working condition" },
    requestDate: "2026-10-13", valuationDueDate: "2026-10-27",
    valuation: { valuedOn: "2026-10-20", valuerName: "TEST Valuer", amountCents: 125_000 },
    outcome: { saleProceedsCents: 100_000, shortfallCents: 25_000, refundCents: 0 } }
  writeFileSync(`${OUT}/s127-valuation-notice.pdf`, await renderSurrenderValuationNotice(surrender))
  writeFileSync(`${OUT}/s127-final-notice.pdf`, await renderSurrenderFinalNotice(surrender))
  const recovery: RecoveryNoticeData = { ...base, reference: "AF-NCA-S131-TEST",
    asset: { description: "2026 TEST TLB", serialNumber: "TEST-SERIAL-131", condition: "Synthetic working condition" },
    recoveredOn: "2026-10-10", location: "TEST Yard",
    valuation: { valuedOn: "2026-10-12", valuerName: "TEST Valuer", amountCents: 125_000 },
    outcome: { settlementDueCents: 150_000, grossProceedsCents: 120_000, deductedCostsCents: 5_000, chargedCostsCents: 2_000, netProceedsCents: 115_000, shortfallCents: 37_000, surplusCents: 0 },
    costs: [{ label: "Towing and transport", grossCents: 5_000, treatment: "DEDUCT_FROM_PROCEEDS" }, { label: "Legal costs (taxed)", grossCents: 2_000, treatment: "CHARGE_TO_ACCOUNT" }] }
  writeFileSync(`${OUT}/s131-valuation-notice.pdf`, await renderRecoveryValuationNotice(recovery))
  writeFileSync(`${OUT}/s131-final-notice.pdf`, await renderRecoveryFinalNotice(recovery))
  writeFileSync(`${OUT}/s127-final-notice-surplus-instructed.pdf`, await renderSurrenderFinalNotice({ ...surrender, surplusDisposition: "INSTRUCTED", outcome: { saleProceedsCents: 175_000, shortfallCents: 0, refundCents: 25_000 } }))
  writeFileSync(`${OUT}/s131-final-notice-surplus-instructed.pdf`, await renderRecoveryFinalNotice({ ...recovery, surplusDisposition: "INSTRUCTED", outcome: { ...recovery.outcome!, grossProceedsCents: 175_000, netProceedsCents: 170_000, shortfallCents: 0, surplusCents: 18_000 } }))
  process.stdout.write(`wrote 8 PDFs to ${OUT}\n`)
}

void main()
