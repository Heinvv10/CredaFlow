// The lease part of a deal's document data (slice 3, C9): the lease terms, the
// rental schedule with VAT at the rate in force on the commencement date, the
// CPA scope and, for a sole-proprietor lessee, the lessee's particulars.
// Read with the rest of the deal (../deal-document-data.ts).
import type { ContractType } from "@prisma/client"
import type { VatTransaction } from "@/lib/vat/db"
import { isLeaseContract, type LeaseContractType, type LeaseTerms } from "../../lease-input"
import { isLeaseTerms } from "../../lease-structure"
import { pricedLeaseSchedule } from "../../lease-schedule"
import type { LeaseScheduleView } from "../../lease-view"
import type { StructureTerms } from "../../deal-input"
import type { AssetPrice, ResolvedRate } from "../../deal-structure"

export interface LeaseDocumentTerms {
  contractType: LeaseContractType
  terms: LeaseTerms
  schedule: LeaseScheduleView
  /** The day the term ends (the asset returns or an end-of-term option is exercised). */
  endDate: string
  cpaApplies: boolean
  cpaRule: string
}

export interface SoleProprietor {
  clientId: string
  name: string
  idNumber: string
  addressLines: string[]
}

export class LeaseDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeaseDocumentError"
  }
}

export function soleProprietorOf(client: {
  id: string; firstName: string; lastName: string; idNumber: string
  addressLine1: string | null; city: string | null; province: string | null; postalCode: string | null
}): SoleProprietor {
  return {
    clientId: client.id,
    name: `${client.firstName} ${client.lastName}`,
    idNumber: client.idNumber,
    addressLines: [client.addressLine1, client.city, client.province, client.postalCode].filter((l): l is string => !!l && l.trim() !== ""),
  }
}

/** null for any contract type but a lease. Throws LeaseDocumentError when it cannot be priced. */
export async function leaseDocumentTerms(
  db: Pick<VatTransaction, "vatRate">,
  deal: { contractType: ContractType; cpaApplies: boolean | null; cpaRule: string | null },
  asset: AssetPrice,
  structure: StructureTerms,
  rate: ResolvedRate,
  startDate: string,
): Promise<LeaseDocumentTerms | null> {
  if (!isLeaseContract(deal.contractType)) return null
  if (!isLeaseTerms(structure) || deal.cpaApplies === null || deal.cpaRule === null) {
    throw new LeaseDocumentError("The lease deal is missing its lease terms or CPA scope")
  }
  const priced = await pricedLeaseSchedule(db, asset, structure, rate, startDate)
  if (!priced.ok) throw new LeaseDocumentError(priced.reason === "vat" ? priced.error : `The rentals cannot be priced: ${priced.error}`)
  return {
    contractType: deal.contractType,
    terms: structure.lease,
    schedule: priced.schedule,
    endDate: priced.endDate,
    cpaApplies: deal.cpaApplies,
    cpaRule: deal.cpaRule,
  }
}
