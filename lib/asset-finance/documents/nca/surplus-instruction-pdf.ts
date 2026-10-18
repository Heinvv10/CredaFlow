import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "../pdf-layout"
export async function renderNcaSurplusPaymentInstruction(input: {
 legalWordingApproved?: boolean; reference: string; issuedAt: Date; loanReference: string; amountCents: number;
 accountHolder: string; bankName: string; branchCode: string; accountNumber: string;
}) {
 const w=await DealDocumentWriter.create({title:`Surplus payment instruction ${input.reference}`,documentDate:input.issuedAt})
 w.title("SURPLUS PAYMENT INSTRUCTION",["Treasury copy — bank details are confidential"])
 w.labelValues([
  ["Instruction reference",input.reference],["Loan",input.loanReference],["Issued",formatDatePdf(input.issuedAt)],
  ["Pay to",input.accountHolder],["Bank",input.bankName],["Branch code",input.branchCode],["Account number",input.accountNumber],["Amount",formatZarPdf(input.amountCents)],
 ])
 w.paragraph("Prepared before the NCA final account notice following separate bank verification and release authorisation. Execute this payment and record bank evidence before issuing the ordinary final notice. Use this reference when executing the transfer. This instruction is not a bank settlement confirmation.")
 return w.finish({reference:input.reference, watermark: !input.legalWordingApproved})
}
