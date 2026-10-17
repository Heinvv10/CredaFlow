import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { legalWordingApproved } from "@/lib/asset-finance/documents/nca/legal-wording-approved"
import { renderNcaSurplusPaymentInstruction } from "@/lib/asset-finance/documents/nca/surplus-instruction-pdf"
export async function GET(req: NextRequest,{params}:{params:Promise<{loanId:string;instructionId:string}>}) {
 const guard=await requireApiRole("READONLY")
 if(guard.error)return guard.error
 return withTenantContext(req,async(tenant)=>{
  const disabled=await requireAssetFinanceEnabled(tenant.id)
  if(disabled)return disabled
  if(!canDo(guard.user.role,"record_payment"))return NextResponse.json({error:"Payment instructions require payment permission"},{status:403})
  const {loanId,instructionId}=await params
  const row=await prisma.ncaSurplusRemittance.findFirst({where:{id:instructionId,tenantId:tenant.id,status:"INSTRUCTED",OR:[{surrender:{loanId,finalNoticePath:{not:null}}},{recovery:{loanId,finalNoticePath:{not:null}}}]},include:{account:true,surrender:{select:{loan:{select:{reference:true}}}},recovery:{select:{loan:{select:{reference:true}}}}}})
  if(!row?.account)return NextResponse.json({error:"Payment instruction not found"},{status:404})
  await logDocumentAccess(prisma,{documentId:row.id,accessorType:"staff",accessorId:guard.user.id,action:"download",req})
  const bytes=await renderNcaSurplusPaymentInstruction({legalWordingApproved:await legalWordingApproved(prisma,tenant.id),reference:row.id,issuedAt:row.releasedAt??row.createdAt,loanReference:row.surrender?.loan.reference??row.recovery!.loan.reference,amountCents:row.amountCents,accountHolder:row.account.accountHolder,bankName:row.account.bankName,branchCode:row.account.branchCode,accountNumber:row.account.accountNumber})
  return new NextResponse(new Uint8Array(bytes),{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="surplus-${row.id}.pdf"`,"Cache-Control":"no-store"}})
 })
}
