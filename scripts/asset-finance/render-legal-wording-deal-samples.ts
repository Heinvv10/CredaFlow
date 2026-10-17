// Renders the lease and commercial asset-finance legal-wording samples (DRAFT
// watermark) to docs/asset-finance/evidence/legal-wording/{lease,commercial}/
// from synthetic fixtures. Deterministic: rerunning reproduces the committed
// PDFs. The lease page images are made from the PDFs with
// `pdftoppm -r 60 -png <name>.pdf <name>`.
//
//   npx tsx scripts/asset-finance/render-legal-wording-deal-samples.ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AnyDealDocumentData } from "@/lib/asset-finance/documents/deal-document-data"
import type { LeaseDocumentTerms } from "@/lib/asset-finance/documents/lease/lease-document-data"
import { LENDER, NOTICE, QUOTE, REPORT } from "@/lib/asset-finance/documents/lease/lease-docs.fixture"
import { leaseScheduleView } from "@/lib/asset-finance/lease-view"
import { priceLease } from "@/lib/asset-finance/lease-pricing"
import { renderInstalmentSaleAgreement } from "@/lib/asset-finance/documents/agreement-pdf"
import { renderLeaseAgreement } from "@/lib/asset-finance/documents/lease/agreement-pdf"
import { renderLeaseExpiryNotice } from "@/lib/asset-finance/documents/lease/expiry-notice-pdf"
import { renderLeaseInspectionReport } from "@/lib/asset-finance/documents/lease/inspection-report-pdf"
import { renderLeaseTerminationQuote } from "@/lib/asset-finance/documents/lease/termination-quote-pdf"
import { renderResolution } from "@/lib/asset-finance/documents/resolution-pdf"
import { renderSuretyship } from "@/lib/asset-finance/documents/suretyship-pdf"
import { syntheticDealDocumentData } from "@/lib/asset-finance/documents/synthetic-deal.fixture"

const LEASE = join(process.cwd(), "docs/asset-finance/evidence/legal-wording/lease")
const COMMERCIAL = join(process.cwd(), "docs/asset-finance/evidence/legal-wording/commercial")
const priced = priceLease({
  cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
  startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
  maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065" }, vatRateTenThousandths: 1500,
})
const lease: LeaseDocumentTerms = {
  contractType: "FULL_MAINTENANCE_LEASE",
  terms: { rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" },
    usage: { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 } },
  schedule: leaseScheduleView(priced, "0.1500"), endDate: "2029-12-31", cpaApplies: false, cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
}
const fml: AnyDealDocumentData = { ...syntheticDealDocumentData(), lease }
const sole: AnyDealDocumentData = {
  ...syntheticDealDocumentData(), entity: null,
  soleProprietor: { clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000", addressLines: ["3 Test Lane", "Pretoria"] },
  signatories: [{ clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000" }], sureties: [],
  lease: { ...lease, contractType: "OPERATING_LEASE", terms: { ...lease.terms, maintenance: null, usage: null }, cpaApplies: true, cpaRule: "CPA_NATURAL_PERSON" },
}

async function main(): Promise<void> {
  writeFileSync(`${LEASE}/fml-agreement-commercial.pdf`, await renderLeaseAgreement(fml))
  writeFileSync(`${LEASE}/operating-lease-agreement-cpa.pdf`, await renderLeaseAgreement(sole))
  writeFileSync(`${LEASE}/expiry-notice.pdf`, await renderLeaseExpiryNotice(NOTICE, LENDER))
  writeFileSync(`${LEASE}/inspection-report.pdf`, await renderLeaseInspectionReport(REPORT, LENDER))
  writeFileSync(`${LEASE}/termination-quote-cpa.pdf`, await renderLeaseTerminationQuote(QUOTE, LENDER))
  writeFileSync(`${LEASE}/termination-quote-commercial.pdf`, await renderLeaseTerminationQuote({ ...QUOTE, cpaCancellation: false, basis: "Present value of the rentals (ex VAT and maintenance) falling due after 2027-02-23, discounted at the contract rate, plus a penalty of 10.00% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value.", terminationDate: "2027-02-23" }, LENDER))
  const d = syntheticDealDocumentData()
  const trust = syntheticDealDocumentData({ entity: { ...d.entity, type: "TRUST", legalName: "TEST Family Trust", registrationNumber: "IT0000/2099", mastersReference: "IT0000/2099" } })
  writeFileSync(join(COMMERCIAL, "instalment-sale-agreement.pdf"), await renderInstalmentSaleAgreement(d))
  writeFileSync(join(COMMERCIAL, "suretyship.pdf"), await renderSuretyship(d, "client-surety"))
  writeFileSync(join(COMMERCIAL, "suretyship-nca-principal.pdf"), await renderSuretyship({ ...d, ncaApplies: true }, "client-surety"))
  writeFileSync(join(COMMERCIAL, "resolution-company.pdf"), await renderResolution(d))
  writeFileSync(join(COMMERCIAL, "resolution-trust.pdf"), await renderResolution(trust))
  process.stdout.write("wrote the lease and commercial samples\n")
}

void main()
