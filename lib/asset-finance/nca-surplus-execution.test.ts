import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
import { parseSurplusExecutionForm } from "./nca-surplus-execution"
function request(overrides: Record<string, string | File> = {}) {
  const f=new FormData()
  const values={executedOn:"2026-10-17",bankReference:"TEST-BANK-0001",amountCents:"12345",destinationAccountId:"TEST-ACCOUNT-ID",destinationConfirmed:"true",docType:"OTHER",file:new File(["%PDF-1.4 synthetic payment proof"],"proof.pdf",{type:"application/pdf"}),...overrides}
  for(const [key,value] of Object.entries(values)) f.set(key,value)
  return new Request("http://localhost/test",{method:"POST",body:f})
}
const invalidCases: Record<string, string>[] = [{amountCents:"1.25"},{amountCents:"9007199254740993"},{executedOn:"2026-02-30"},{bankReference:"x"},{docType:"ID_DOCUMENT"},{destinationAccountId:""},{destinationConfirmed:"false"}]
describe("manual NCA surplus bank execution evidence input",()=>{
 it("accepts an exact amount, calendar date, reference and magic-checked bank proof",async()=>{
  expect(await parseSurplusExecutionForm(request())).toMatchObject({ok:true,amountCents:12345,executedOn:"2026-10-17",bankReference:"TEST-BANK-0001"})
 })
 it.each(invalidCases)("refuses malformed execution input %j",async(fields)=>{
  expect(await parseSurplusExecutionForm(request(fields))).toMatchObject({ok:false})
 })
 it("refuses PDF-labelled bytes without PDF magic",async()=>{
  expect(await parseSurplusExecutionForm(request({file:new File(["not a PDF"],"proof.pdf",{type:"application/pdf"})}))).toMatchObject({ok:false,error:"File content does not match its type"})
 })
})
