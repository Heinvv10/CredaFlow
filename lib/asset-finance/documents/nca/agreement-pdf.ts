import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "../pdf-layout"
import { introducerSection, rateDescription } from "../document-parts"
import { ncaAgreementClauses } from "../wording/nca-agreement"
import type { NcaAssetDocumentData } from "./types"
import { additionalTerms, identityTokens, wordingWatermark, type AppliedWording } from "../templates/apply"

/**
 * Issued, `wording` is the lender's approved template version: its additional
 * terms follow clause 11, whose s90 saving (11.3) covers them, and its mark
 * replaces the DRAFT subtitle and watermark. Without it: the starter and the
 * legacy flag (sample renders and tests).
 */
export async function renderNcaAssetAgreement(data: NcaAssetDocumentData, wording?: AppliedWording): Promise<Buffer> {
  const mark = wordingWatermark(wording, data.legalWordingApproved)
  const kind = data.contractType === "FINANCE_LEASE" ? "FINANCE LEASE" : "INSTALMENT SALE"
  const w = await DealDocumentWriter.create({ title: `NCA ${kind} Agreement ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(`NCA ${kind} AGREEMENT`, [`Reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    ...(mark === "DRAFT" ? ["DRAFT legal wording — not for execution"] : mark === "SYNTHETIC_DEMO" ? ["Synthetic demo approval — not legally approved, not for execution"] : []),
  ])
  w.section("PARTIES AND ASSET")
  w.labelValues([
    ["Credit provider", data.lender.legalName], ["Consumer", data.borrower.name],
    ["Identity / registration", data.borrower.identityNumber], ["Address", data.borrower.addressLines.join("\n")],
    ["Asset", data.asset.description], ["Serial / VIN", data.asset.serialNumber],
  ])
  const p = data.pricing
  w.section("FINANCIAL TERMS")
  w.labelValues([
    ["Cash price", formatZarPdf(p.cashPriceCents)], ["Deposit", formatZarPdf(p.depositCents)],
    ["Credit-life premium", formatZarPdf(p.creditLifePremiumCents)],
    ["Principal debt", formatZarPdf(p.principalCents)], ["Annual interest", rateDescription(p)],
    ["Instalment", formatZarPdf(p.instalmentCents)], ["Residual / balloon", formatZarPdf(p.balloonCents)],
    ["Initiation fee", formatZarPdf(p.initiationFeeCents)], ["Monthly service fee", formatZarPdf(p.monthlyServiceFeeCents)],
    ["Total cost of credit", formatZarPdf(p.totalCostOfCreditCents)],
  ])
  if (data.dealer) introducerSection(w, data.dealer, "NCA_AGREEMENT")
  w.section("TERMS AND CONDITIONS")
  const clauses = ncaAgreementClauses(data)
  clauses.forEach((c, i) => w.clause(String(i + 1), c.heading, c.text))
  additionalTerms(wording, identityTokens(data.lender, data.reference)).forEach((c, i) => w.clause(String(clauses.length + i + 1), c.heading, c.text))
  w.section("SIGNATURES")
  w.signatures([
    { caption: "Consumer", name: data.borrower.name },
    { caption: "Credit provider", name: data.lender.legalName, detail: "Authorised countersignatory" },
  ])
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved, mark })
}
