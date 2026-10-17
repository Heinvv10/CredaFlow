// Full-maintenance lease clauses 9.16–9.17: the maintenance the lessor
// arranges, the maintenance fund and its end-of-term settlement under the
// deal's risk model (lib/asset-finance/maintenance-fund.ts), and claims paid
// to approved providers (lib/asset-finance/maintenance-claims.ts).
import { Prisma } from "@prisma/client"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { percentPdf } from "../document-parts"
import type { LeaseWordingInput, WordingClause } from "./lease-agreement"

const para = (...parts: string[]): string => parts.join("\n\n")

const SETTLEMENT = {
  LENDER_RISK: "At the end of the term the lessor keeps any surplus in the fund and bears any deficit: the lessee is not billed for a deficit and is not refunded a surplus.",
  LESSEE_SETTLED: "At the end of the term, whatever the outcome under clause 9.9, the fund is settled: a surplus is refunded to the lessee, and a deficit is billed to the "
    + "lessee, plus VAT, on the end-of-term tax invoice (clause 9.8).",
} as const

function maintenanceFund(i: LeaseWordingInput): string {
  const m = i.terms.maintenance
  if (!m) throw new RangeError("maintenanceClauses: a full-maintenance lease needs its maintenance terms")
  const escalation = new Prisma.Decimal(m.escalationRate).isZero()
    ? "which does not escalate"
    : `escalating by ${percentPdf(m.escalationRate)} on each anniversary of the commencement date`
  return para(
    `In return for the maintenance charge of ${formatZarPdf(m.monthlyExclVatCents)} a month excl. VAT (${escalation}; Annexure A and section 6), the lessor arranges `
    + "and pays for the maintenance of the goods during the term and any extension: the services the manufacturer schedules, and the repair or replacement of parts that "
    + "fail through fair wear and tear within the contracted usage.",
    "Maintenance does not include: fuel, and oil and fluid top-ups between services; cleaning; damage from accident, misuse, overloading, neglect or operator error; work "
    + "needed because the goods were not presented for a scheduled service or were used beyond the contracted usage; alterations; or anything the insurance under clause 9.5 "
    + "covers or should have covered. The lessee pays for that work itself.",
    "The lessee must present the goods for every scheduled service, report any fault to the lessor promptly, and stop using the goods if using them could make a fault worse.",
    "The maintenance part of each invoiced rental (excl. VAT) is credited to a maintenance fund kept for this lease, and each maintenance claim the lessor pays under clause "
    + "9.17 is debited to it. The fund may run into deficit during the term; that does not reduce the maintenance the lessor arranges. The lessee may see the fund's balance "
    + `through the lessor's portal. ${SETTLEMENT[m.riskModel]}`,
  )
}

function claims(): string {
  return para(
    "Maintenance is done only by providers the lessor approves. The lessee should ask the lessor before work starts whether it is maintenance under clause 9.16. "
    + "The provider invoices the work; the lessor approves the claim against that invoice and pays the provider directly. The lessee does not pay the provider for "
    + "approved maintenance.",
    "The lessor may reject a claim for work that is not maintenance under clause 9.16 or that was not done by an approved provider; the lessee then pays for that work. "
    + "No claim is accepted for work done after the lease ends, or once the maintenance fund has been settled at the end of the term.",
  )
}

export function maintenanceClauses(i: LeaseWordingInput): WordingClause[] {
  return [
    { heading: "Maintenance by the lessor and the maintenance fund", text: maintenanceFund(i) },
    { heading: "Maintenance claims and approved providers", text: claims() },
  ]
}
