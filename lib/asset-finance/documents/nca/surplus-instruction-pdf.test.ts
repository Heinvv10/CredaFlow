import { describe,expect,it } from "vitest"
import { renderNcaSurplusPaymentInstruction } from "./surplus-instruction-pdf"
import { texts,prose } from "./nca-wording.test-helpers"
describe("surplus payment instruction",()=>{
 it("prints the exact authorised account, amount and instruction reference without claiming bank settlement",async()=>{
  const bytes=await renderNcaSurplusPaymentInstruction({reference:"SYNTHETIC-INSTRUCTION-1",issuedAt:new Date("2026-10-17T10:00:00Z"),loanReference:"SYNTHETIC-NCA-1",amountCents:12345,accountHolder:"TEST Borrower",bankName:"TEST Bank",branchCode:"000000",accountNumber:"0000000001"})
  const all=await texts(bytes)
  expect(all).toEqual(expect.arrayContaining(["SYNTHETIC-INSTRUCTION-1","TEST Borrower","0000000001","R 123.45"]))
  expect(prose(all)).toContain("not a bank settlement confirmation")
 })
})
