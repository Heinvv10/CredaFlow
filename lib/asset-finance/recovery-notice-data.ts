import { getLenderIdentity } from "@/lib/config/identity"
import { prisma } from "@/lib/prisma"
import type { RecoveryNoticeData } from "./documents/nca/recovery-pdf"
import { legalWordingApproved } from "./documents/nca/legal-wording-approved"
import { isoOfDbDate } from "./dates"
import { COST_TYPE_LABELS } from "./recovery-labels"

/** Everything a recovery notice or statement prints, with the recovery's route and notice columns the caller decides on. */
export async function loadRecoveryNoticeData(tenantId: string, id: string, documentDate: Date) {
  const row = await prisma.recovery.findFirst({ where: { id, tenantId }, include: {
    valuation: true,
    asset: true,
    loan: { select: { reference: true, client: true, entity: true } },
    costs: { where: { status: "APPROVED" }, orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }] },
  } })
  if (!row) return null
  const [lender, approved] = await Promise.all([getLenderIdentity(tenantId), legalWordingApproved(prisma, tenantId)])
  const { client, entity } = row.loan
  const borrower = client ? {
    name: `${client.firstName} ${client.lastName}`, identityNumber: client.idNumber,
    addressLines: [client.addressLine1, client.city, client.province, client.postalCode].filter((v): v is string => !!v),
  } : entity ? {
    name: entity.legalName, identityNumber: entity.registrationNumber,
    addressLines: [entity.addressLine1, entity.addressLine2, entity.city, entity.province, entity.postalCode].filter((v): v is string => !!v),
  } : { name: "Unknown borrower", identityNumber: "Unknown", addressLines: [] }
  const figures = row.settlementDueCents === null || row.grossProceedsCents === null || row.deductedCostsCents === null || row.chargedCostsCents === null
    || row.netProceedsCents === null || row.shortfallCents === null || row.surplusCents === null ? undefined : {
      settlementDueCents: row.settlementDueCents, grossProceedsCents: row.grossProceedsCents, deductedCostsCents: row.deductedCostsCents,
      chargedCostsCents: row.chargedCostsCents, netProceedsCents: row.netProceedsCents, shortfallCents: row.shortfallCents, surplusCents: row.surplusCents,
      unrecoverableCostsCents: row.unrecoverableCostsCents ?? undefined,
    }
  const data: RecoveryNoticeData = {
    legalWordingApproved: approved, reference: row.loan.reference, documentDate,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines }, borrower,
    asset: { description: `${row.asset.year} ${row.asset.make} ${row.asset.model}`, serialNumber: row.asset.vin ?? row.asset.serialNumber, condition: row.condition },
    recoveredOn: isoOfDbDate(row.recoveredOn), location: row.location,
    valuation: row.valuation ? { valuedOn: isoOfDbDate(row.valuation.valuedOn), valuerName: row.valuation.valuerName, amountCents: row.valuation.amountCents } : undefined,
    outcome: figures,
    costs: row.costs.map((c) => ({ label: COST_TYPE_LABELS[c.type], grossCents: c.grossCents, treatment: c.treatment })),
  }
  return { row, data }
}
