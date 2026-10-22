/**
 * Staff registering and editing a dealer or broker (manage_dealers, checked by
 * the route). Deactivation is lib/dealer/users.ts deactivateDealer (it ends
 * every one of the dealer's sessions). A dealer is a VAT vendor exactly when it
 * has a VAT number (CHECK Dealer_vat_vendor_shape), so vatVendor is derived,
 * never sent. A linked supplier (the dealer's default supplier on its deals)
 * must be the lender's own; one dealer per supplier and per name (unique keys).
 * Every write is audited.
 */
import { Prisma, type DealerKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { asRecord, readEnum, readText, type Errors, type Fields } from "@/lib/asset-finance/input-fields"
import { SA_VAT_NUMBER } from "@/lib/asset-finance/settings-input"
import { dealerNameProblem } from "@/lib/asset-finance/documents/wording/dealer-name"
import type { StaffActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const DEALER_KINDS: readonly DealerKind[] = ["DEALER", "BROKER"]
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface DealerFields {
  name: string
  kind: DealerKind
  registrationNumber: string | null
  vatNumber: string | null
  supplierId: string | null
  contactEmail: string
  contactPhone: string | null
}

type Parsed<T> = { data: T } | { errors: Errors }

/** The dealer fields of a create (`partial` false) or an edit body. */
export function parseDealerInput(body: unknown, partial: false): Parsed<DealerFields>
export function parseDealerInput(body: unknown, partial: true): Parsed<Partial<DealerFields>>
export function parseDealerInput(body: unknown, partial: boolean): Parsed<Partial<DealerFields>> {
  const raw = asRecord(body)
  if (!raw) return { errors: { body: "must be a JSON object" } }
  const record = typeof raw.vatNumber === "string" ? { ...raw, vatNumber: raw.vatNumber.replace(/\s/g, "") } : raw
  const out: Fields = {}
  const errors: Errors = {}
  readText(record, "name", out, errors, { required: !partial, nullable: false, max: 160 })
  readEnum(record, "kind", out, errors, { required: !partial, values: DEALER_KINDS })
  readText(record, "registrationNumber", out, errors, { required: false, nullable: true, max: 32, upper: true })
  readText(record, "vatNumber", out, errors, { required: false, nullable: true, max: 10 })
  readText(record, "supplierId", out, errors, { required: false, nullable: true, max: 64 })
  readText(record, "contactEmail", out, errors, { required: !partial, nullable: false, max: 160 })
  readText(record, "contactPhone", out, errors, { required: false, nullable: true, max: 32 })
  // The name is printed in the agreements' commission disclosure: a trading name only.
  if (typeof out.name === "string") {
    const problem = dealerNameProblem(out.name)
    if (problem) errors.name = problem
  }
  if (typeof out.vatNumber === "string" && !SA_VAT_NUMBER.test(out.vatNumber)) errors.vatNumber = "must be ten digits starting with 4"
  const email = out.contactEmail
  if (typeof email === "string") {
    out.contactEmail = email.toLowerCase()
    if (!EMAIL.test(email)) errors.contactEmail = "must be an email address"
  }
  if (Object.keys(errors).length > 0) return { errors }
  if (Object.keys(out).length === 0) return { errors: { body: "has no dealer fields to change" } }
  if (partial) return { data: out as Partial<DealerFields> }
  return { data: { registrationNumber: null, vatNumber: null, supplierId: null, contactPhone: null, ...out } as DealerFields }
}

/** vatVendor follows vatNumber whenever the number is written. */
const withVendor = <T extends Partial<DealerFields>>(fields: T) =>
  "vatNumber" in fields ? { ...fields, vatVendor: fields.vatNumber !== null && fields.vatNumber !== undefined } : fields

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function supplierRefusal(tx: Pick<Tx, "supplier">, tenantId: string, supplierId: string | null | undefined): Promise<DealerRefusal | null> {
  if (!supplierId) return null
  const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } })
  return supplier ? null : dealerRefused(422, "The linked supplier is not one of the lender's suppliers")
}

function uniqueRefusal(error: unknown): DealerRefusal | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return null
  const target = JSON.stringify(error.meta?.target ?? "")
  if (target.includes("supplierId")) return dealerRefused(409, "That supplier is already linked to another dealer")
  return dealerRefused(409, "A dealer with this name is already registered")
}

export async function createDealer(staff: StaffActor, input: DealerFields): Promise<{ kind: "created"; dealerId: string } | DealerRefusal> {
  try {
    return await prisma.$transaction(async (tx) => {
      const refused = await supplierRefusal(tx, staff.tenantId, input.supplierId)
      if (refused) return refused
      const data = withVendor(input)
      const row = await tx.dealer.create({ data: { ...data, tenantId: staff.tenantId, createdById: staff.userId }, select: { id: true } })
      await logAuditStrict({
        tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
        action: AuditAction.DEALER_CREATED, entity: "Dealer", entityId: row.id, newValue: { ...data },
      }, tx)
      return { kind: "created" as const, dealerId: row.id }
    })
  } catch (error) {
    const refused = uniqueRefusal(error)
    if (refused) return refused
    throw error
  }
}

/** Edits a dealer's details. A deactivated dealer is not edited (nothing can reactivate it). */
export async function updateDealer(
  staff: StaffActor,
  dealerId: string,
  changes: Partial<DealerFields>,
): Promise<{ kind: "updated" } | DealerRefusal> {
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.dealer.findFirst({ where: { id: dealerId, tenantId: staff.tenantId } })
      if (!before) return dealerMiss("Dealer")
      if (!before.active) return dealerRefused(409, "The dealer is deactivated")
      const refused = await supplierRefusal(tx, staff.tenantId, changes.supplierId)
      if (refused) return refused
      const data = withVendor(changes)
      await tx.dealer.update({ where: { id: dealerId, tenantId: staff.tenantId }, data })
      const oldValue: Record<string, unknown> = {}
      for (const key of Object.keys(data)) oldValue[key] = before[key as keyof typeof before]
      await logAuditStrict({
        tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
        action: AuditAction.DEALER_UPDATED, entity: "Dealer", entityId: dealerId, oldValue, newValue: { ...data },
      }, tx)
      return { kind: "updated" as const }
    })
  } catch (error) {
    const refused = uniqueRefusal(error)
    if (refused) return refused
    throw error
  }
}
