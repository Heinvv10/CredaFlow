import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
export async function GET(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
 const guard=await requireApiRole("READONLY")
 if (guard.error) return guard.error
 return withTenantContext(req,async(tenant)=>{
  const disabled=await requireAssetFinanceEnabled(tenant.id)
  if(disabled)return disabled
  if(!canDo(guard.user.role,"manage_asset_finance"))return NextResponse.json({error:"Bank evidence requires authorised staff"},{status:403})
  const {loanId}=await params
  const row=await prisma.ncaSurplusAccount.findFirst({where:{tenantId:tenant.id,loanId},select:{evidenceDocument:{select:{id:true,fileName:true,mimeType:true,storagePath:true,contentSha256:true,deletedAt:true}}}})
  if(!row || row.evidenceDocument.deletedAt)return NextResponse.json({error:"Bank evidence not found"},{status:404})
  return serveEntityDocument(req,row.evidenceDocument,{type:"staff",id:guard.user.id})
 })
}
