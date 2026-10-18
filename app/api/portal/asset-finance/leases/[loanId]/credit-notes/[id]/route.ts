import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalLeaseDocument, portalLeaseNotFound } from "@/lib/asset-finance/lease-portal-route"
import { serveCreditNotePdf } from "@/lib/vat/credit-note-serve"
export async function GET(req:NextRequest,{params}:{params:Promise<{loanId:string;id:string}>}){
 const {loanId,id}=await params
 return withPortalLeaseDocument(req,loanId,{entity:"CreditNote",entityId:id},async({tenantId,client})=>{
  const owned=await prisma.creditNote.findFirst({where:{id,tenantId,invoice:{loanId,tenantId}},select:{id:true}})
  if(!owned)return portalLeaseNotFound()
  return await serveCreditNotePdf(prisma,req,{tenantId,id},{type:"client",id:client.clientId}) ?? portalLeaseNotFound()
 })
}
