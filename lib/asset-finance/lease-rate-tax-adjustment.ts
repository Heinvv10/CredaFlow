import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { isoOfDbDate } from "./dates"
import { rateTaxDocuments, type RateTaxDocument } from "./rate-tax-documents"
import type { RepriceTx } from "./reprice-loan"

export interface PendingLeaseRateTax {
  rentalId: string
  periodNo: number
  exclVatCents: number
  estimatedGrossCents: number
}
export const objectEvidence = (value: Prisma.JsonValue) => value && typeof value === "object" && !Array.isArray(value) ? value : {}
export function pendingLeaseRateTax(value: Prisma.JsonValue): PendingLeaseRateTax[] {
  const pending=objectEvidence(value).pendingTaxAdjustments
  if(!Array.isArray(pending))return []
  return pending.filter(x=>x && typeof x === "object" && !Array.isArray(x) && typeof x.rentalId === "string" && Number.isSafeInteger(x.periodNo) && Number.isSafeInteger(x.exclVatCents) && Number.isSafeInteger(x.estimatedGrossCents)) as unknown as PendingLeaseRateTax[]
}

/** Each note adjusts this rental's own original supply, at its actual VAT rate. */
export async function issueRentalRateTaxDocument(tx: RepriceTx,input:{tenantId:string;loanId:string;invoiceId:string;periodNo:number;exclVatCents:number;issueDate:string;effectiveDate:string;actorUserId?:string|null}):Promise<RateTaxDocument>{
 const original=await tx.taxInvoice.findFirstOrThrow({where:{tenantId:input.tenantId,id:input.invoiceId,loanId:input.loanId}})
 const reason=`Rental-only reference-rate correction, period ${input.periodNo}, effective ${input.effectiveDate}`
 const common={invoiceId:original.id,periodNo:input.periodNo,originalInvoiceNumber:original.invoiceNumber,issueDate:input.issueDate,reason,supplierName:original.supplierName,supplierAddress:original.supplierAddress,supplierVatNumber:original.supplierVatNumber,recipientName:original.recipientName,recipientAddress:original.recipientAddress,recipientVatNumber:original.recipientVatNumber,vatRate:original.vatRate.toString()}
 if(input.exclVatCents<0){
  const note=await issueCreditNote(tx,{tenantId:input.tenantId,invoiceId:original.id,issueDate:input.issueDate,reason,exclVatCents:-input.exclVatCents,createdById:input.actorUserId})
  return {...common,kind:"CREDIT_NOTE",id:note.id,number:note.creditNoteNumber,exclVatCents:-note.exclVatCents,vatCents:-note.vatCents,inclVatCents:-note.inclVatCents}
 }
 const note=await issueTaxInvoice(tx,{tenantId:input.tenantId,loanId:input.loanId,issueDate:input.issueDate,supplyDate:isoOfDbDate(original.supplyDate),debitNoteForInvoiceId:original.id,adjustmentReason:reason,recipient:{name:original.recipientName,address:original.recipientAddress,vatNumber:original.recipientVatNumber},lines:[{description:reason,quantity:1,unitExclVatCents:input.exclVatCents}],createdById:input.actorUserId})
 return {...common,kind:"DEBIT_NOTE",id:note.id,number:note.invoiceNumber,exclVatCents:note.totalExclVatCents,vatCents:note.vatCents,inclVatCents:note.totalInclVatCents}
}

type TaxTx=Pick<RepriceTx,"assetFinanceRateCorrection"|"assetFinanceRateNotice"|"leaseRental"|"contractRate"|"taxInvoice"|"creditNote"|"vatConfig"|"vatRate"|"auditLog"|"$executeRaw"|"$executeRawUnsafe">
/** Called only after the actual rental invoice is bound, or an unmade rental
 * is cancelled. The unique causal event consumes the pending supply once. */
export async function consumeDeferredLeaseRateTax(tx:TaxTx,input:{tenantId:string;loanId:string;rentalIds:string[];invoiceId?:string;today:string;actorUserId:string|null}):Promise<void>{
 const sources=await tx.assetFinanceRateCorrection.findMany({where:{tenantId:input.tenantId,loanId:input.loanId,reason:"LATE_CLOSED_LEASE_RATE"},include:{contractRate:{select:{effectiveDate:true}}}})
 for(const source of sources)for(const pending of pendingLeaseRateTax(source.contractualRows)){
  if(!input.rentalIds.includes(pending.rentalId))continue
  const cause=`LEASE_TAX:${source.id}:${pending.rentalId}`
  if(await tx.assetFinanceRateCorrection.findUnique({where:{cause}}))continue
  const rental=await tx.leaseRental.findFirstOrThrow({where:{tenantId:input.tenantId,loanId:input.loanId,id:pending.rentalId},select:{taxInvoiceId:true,cancelledAt:true,dueDate:true}})
  if(input.invoiceId){
    if(rental.taxInvoiceId!==input.invoiceId || rental.cancelledAt)throw new Error("Deferred rate tax document needs this rental's actual original invoice")
  }else if(!rental.cancelledAt || rental.taxInvoiceId || isoOfDbDate(rental.dueDate)<=input.today){
    throw new Error("Deferred rate tax cancellation needs an actually cancelled unmade rental supply")
  }
  const doc=input.invoiceId?await issueRentalRateTaxDocument(tx as RepriceTx,{...input,invoiceId:input.invoiceId,periodNo:pending.periodNo,exclVatCents:pending.exclVatCents,issueDate:input.today,effectiveDate:isoOfDbDate(source.contractRate.effectiveDate)}):null
  const delta=(doc?.inclVatCents??0)-pending.estimatedGrossCents
  const total=await tx.assetFinanceRateCorrection.aggregate({where:{tenantId:input.tenantId,loanId:input.loanId},_sum:{amountCents:true}})
  await tx.assetFinanceRateCorrection.create({data:{tenantId:input.tenantId,loanId:input.loanId,contractRateId:source.contractRateId,cause,amountCents:delta,cumulativeAmountCents:(total._sum.amountCents??0)+delta,reason:doc?"LEASE_SUPPLY_TAX_ADJUSTMENT":"LEASE_SUPPLY_TAX_CANCELLED",contractualRows:{sourceCorrectionId:source.id,rentalId:pending.rentalId,periodNo:pending.periodNo,exclVatAdjustmentCents:doc?0:-pending.exclVatCents,taxDocuments:doc?[doc]:[]} as unknown as Prisma.InputJsonValue}})
  const notice=await tx.assetFinanceRateNotice.findFirst({where:{tenantId:input.tenantId,loanId:input.loanId,contractRateId:source.contractRateId}})
  if(notice){
   const events=await tx.assetFinanceRateCorrection.findMany({where:{tenantId:input.tenantId,loanId:input.loanId,cause:{startsWith:`LEASE_TAX:${source.id}:`}},select:{cause:true}})
   const remaining=pendingLeaseRateTax(source.contractualRows).some(item=>!events.some(event=>event.cause===`LEASE_TAX:${source.id}:${item.rentalId}`))
   await tx.assetFinanceRateNotice.update({where:{id:notice.id,tenantId:input.tenantId},data:{historicalBalanceAdjustmentCents:notice.historicalBalanceAdjustmentCents+delta,taxAdjustmentPending:remaining,taxAdjustmentRevision:{increment:1},taxDocuments:[...rateTaxDocuments(notice.taxDocuments),...(doc?[doc]:[])] as unknown as Prisma.InputJsonValue,completedAt:null,lastOutcomes:Prisma.DbNull}})
  }
  await logAuditStrict({tenantId:input.tenantId,userId:input.actorUserId??undefined,action:AuditAction.LEASE_RENTAL_INVOICED,entity:"Loan",entityId:input.loanId,newValue:{source:doc?"deferred_rate_tax_supply":"deferred_rate_tax_cancelled",sourceCorrectionId:source.id,rentalId:pending.rentalId,amountCents:delta,taxDocuments:doc?[doc]:[]}},tx)
 }
}
