import { describe, expect, it } from "vitest"
import { correctionBalance } from "./rate-correction"
import { rateTaxDocuments, rateTaxDocumentText } from "./rate-tax-documents"
import { Prisma } from "@prisma/client"
import { rateNoticeVars } from "./reprice-notice-dispatch"

describe("independent D checkpoint review probes", () => {
  it("splits a leap-year rate change on its effective day using Actual/365", () => {
    // Jan 2..31: 30 days at 10%; Feb 1..Mar 1: 30 days at 20%.
    const balance = correctionBalance(365000, "2024-01-01", [{ effectiveDate:"2024-01-01", annualRate:.1 },{ effectiveDate:"2024-02-01", annualRate:.2 }], [{ day:"2024-03-01", capitalCashCents:100000 }])
    expect(balance).toBe(274000)
  })
  it("does not turn an unexecuted correction into a refund claim or unsafe HTML", () => {
    const vars = rateNoticeVars({ resultingRate:new Prisma.Decimal(.125), loanReference:"<img src=x>", effectiveDate:new Date("2026-01-01"), firstChangedPaymentDate:new Date("2026-02-01"), oldInstalmentCents:0,newInstalmentCents:0, correctionPendingManual:true,historicalBalanceAdjustmentCents:-1200,totalInterestCents:10000,monthlyInterestCents:1000,taxDocuments:[] } as never,{id:"synthetic",firstName:"<script>",lastName:"Borrower",email:"synthetic@invalid.test"},true)
    expect(vars.text).toContain("no refund or debit has been executed")
    expect(vars.html).not.toContain("<script>")
    expect(vars.html).toContain("&lt;img src=x&gt;")
    expect(vars.text).toContain("12.50%")
  })
  it("renders the immutable original transaction and supplier VAT particulars", () => {
    const docs=rateTaxDocuments([{ kind:"DEBIT_NOTE",id:"dn",invoiceId:"original",periodNo:1,number:"DN-1",originalInvoiceNumber:"INV-1",issueDate:"2026-10-17",reason:"Reference rate increase",supplierName:"Synthetic Lessor",supplierAddress:"Synthetic address",supplierVatNumber:"4000000001",recipientName:"Synthetic Lessee",recipientAddress:"Synthetic address",recipientVatNumber:null,vatRate:"0.15",exclVatCents:10000,vatCents:1500,inclVatCents:11500 }])
    expect(docs).toHaveLength(1)
    expect(rateTaxDocumentText(docs[0])).toContain("Original transaction: tax invoice INV-1")
    expect(rateTaxDocumentText(docs[0])).toContain("VAT 4000000001")
    expect(rateTaxDocumentText(docs[0])).toContain("R115.00")
  })
})
