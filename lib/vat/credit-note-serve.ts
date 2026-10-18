import { NextResponse } from "next/server"
import type { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { generateTaxInvoicePdf } from "./tax-invoice-pdf"
/** Original supply's immutable parties and tax rate; log access before render. */
export async function serveCreditNotePdf(db: Pick<typeof prisma,"creditNote"|"documentAccessLog">, req: Request, target:{tenantId:string;id:string}, accessor:{type:"staff"|"client";id:string}):Promise<NextResponse|null>{
 const note=await db.creditNote.findFirst({where:{id:target.id,tenantId:target.tenantId},include:{invoice:true}})
 if(!note)return null
 const download=new URL(req.url).searchParams.get("download")==="1"
 await logDocumentAccess(db,{documentId:note.id,accessorType:accessor.type,accessorId:accessor.id,action:download?"download":"view",req})
 const pdf=await generateTaxInvoicePdf({...note.invoice,adjustmentKind:"CREDIT_NOTE",adjustmentReason:note.reason,originalInvoiceNumber:note.invoice.invoiceNumber,invoiceNumber:note.creditNoteNumber,issueDate:note.issueDate,createdAt:note.createdAt,totalExclVatCents:note.exclVatCents,vatCents:note.vatCents,totalInclVatCents:note.inclVatCents,lines:[{lineNo:1,description:note.reason,quantity:1,unitExclVatCents:note.exclVatCents,exclVatCents:note.exclVatCents,vatCents:note.vatCents,inclVatCents:note.inclVatCents}]})
 return new NextResponse(new Uint8Array(pdf),{headers:{"Content-Type":"application/pdf","Content-Disposition":`${download?"attachment":"inline"}; filename="credit-note-${note.creditNoteNumber}.pdf"`,"Content-Length":String(pdf.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}})
}
