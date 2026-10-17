import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "../pdf-layout"
import { rateDescription } from "../document-parts"
import { ncaAgreementClauses } from "../wording/nca-agreement"
import type { NcaAssetDocumentData } from "./types"

export async function renderNcaAssetAgreement(data: NcaAssetDocumentData): Promise<Buffer> {
  const kind = data.contractType === "FINANCE_LEASE" ? "FINANCE LEASE" : "INSTALMENT SALE"
  const w = await DealDocumentWriter.create({ title: `NCA ${kind} Agreement ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(`NCA ${kind} AGREEMENT`, [`Reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    ...(data.legalWordingApproved ? [] : ["DRAFT legal wording — not for execution"]),
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
    ["Principal debt", formatZarPdf(p.principalCents)], ["Annual interest", rateDescription(p)],
    ["Instalment", formatZarPdf(p.instalmentCents)], ["Residual / balloon", formatZarPdf(p.balloonCents)],
    ["Initiation fee", formatZarPdf(p.initiationFeeCents)], ["Monthly service fee", formatZarPdf(p.monthlyServiceFeeCents)],
    ["Total cost of credit", formatZarPdf(p.totalCostOfCreditCents)], ["Total repayable", formatZarPdf(p.totalRepayableCents)],
  ])
  w.section("TERMS AND CONDITIONS")
  ncaAgreementClauses(data).forEach((c, i) => w.clause(String(i + 1), c.heading, c.text))
  w.section("SIGNATURES")
  w.signatures([
    { caption: "Consumer", name: data.borrower.name },
    { caption: "Credit provider", name: data.lender.legalName, detail: "Authorised countersignatory" },
  ])
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}
