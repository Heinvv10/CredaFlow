import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BoardPackClient } from "./BoardPackClient"
import { BoardPackDefaultCharges } from "./BoardPackDefaultCharges"

const base = {
  lenderName: "Acme Lending", ncrNumber: "NCRCP99999",
  book: 0, activeLoans: 0, clients: 0, collectionsRate: null, arrearsRate: null,
  totalArrears: 0, totalDisbursed: 0, topLoans: [], productMix: [], insurancePolicies: 0, monthlyPremiums: 0,
}
const account = { clientName: "Thandi Mocktest", daysInArrears: 45, arrearsAmount: 216_900, outstandingPrincipal: 200_000, reference: "LN-000000000001" }
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("BoardPackClient identity", () => {
  it("prints the tenant's brand and NCR number, or says it is not configured", () => {
    const html = text(renderToStaticMarkup(<BoardPackClient {...base} buckets={[]} delinquentAccounts={[]} />))
    expect(html).toContain("Acme Lending")
    expect(html).toContain("NCR Reg: NCRCP99999")
    const unset = text(renderToStaticMarkup(<BoardPackClient {...base} ncrNumber={null} buckets={[]} delinquentAccounts={[]} />))
    expect(unset).toContain("NCR Reg: not configured")
  })
})

describe("BoardPackClient default charges", () => {
  it("shows charges beside the instalment arrears in the bands and delinquent accounts while live", () => {
    const html = text(renderToStaticMarkup(
      <BoardPackClient
        {...base}
        buckets={[{ label: "31-60 DPD", count: 1, value: 216_900, charges: 12_345 }]}
        delinquentAccounts={[{ ...account, chargesOwing: 12_345 }]}
        defaultCharges={<p>charges-section</p>}
      />,
    ))
    expect(html).toContain("+ R 123.45 default charges")
    expect(html).toContain("Default charges")
    // Arrears stays the instalment figure; the charge sits in its own cell.
    expect(html).toMatch(/R 2,169\.00 R 123\.45/)
    expect(html).toContain("charges-section")
  })

  it("shows no charge column or line while charges are not live", () => {
    const html = text(renderToStaticMarkup(
      <BoardPackClient {...base} buckets={[{ label: "31-60 DPD", count: 1, value: 216_900 }]} delinquentAccounts={[account]} />,
    ))
    expect(html).not.toContain("default charges")
    expect(html).not.toContain("Default charges")
  })
})

describe("BoardPackClient NCA regime", () => {
  it("states the NON_NCA share of the arrears aging separately, and nothing when there is none", () => {
    const buckets = [{ label: "31-60 DPD", count: 3, value: 900_000 }]
    const html = text(renderToStaticMarkup(
      <BoardPackClient {...base} buckets={buckets} nonNcaArrears={{ count: 2, value: 600_000 }} delinquentAccounts={[]} />,
    ))
    expect(html).toContain("Of which NON_NCA (asset finance, not NCA-regulated): 2 accounts, R 6,000.00 in arrears.")
    const none = text(renderToStaticMarkup(
      <BoardPackClient {...base} buckets={buckets} nonNcaArrears={{ count: 0, value: 0 }} delinquentAccounts={[]} />,
    ))
    expect(none).not.toContain("NON_NCA")
  })
})

describe("BoardPackDefaultCharges", () => {
  it("states this month's flows and what is owing now, split to tie to the bands", () => {
    const html = text(renderToStaticMarkup(
      <BoardPackDefaultCharges summary={{
        accrued: 30_000, collected: 10_000, owingInBands: 12_000, owingNotInArrears: 3_000, owingElsewhere: 5_000,
        exemptionRefunds: { count: 1, amount: 500 },
      }} />,
    ))
    expect(html).toContain("This month: accrued R 300.00, collected R 100.00.")
    expect(html).toContain("R 120.00 on accounts in arrears")
    expect(html).toContain("R 30.00 on accounts with no instalment arrears")
    expect(html).toContain("R 50.00 on written-off and closed loans")
    expect(html).toContain("Charges to refund after exemptions: R 5.00 (1)")
  })
})
