/**
 * The ONLY write path for lender identity (see lib/config/identity.ts).
 *
 * Validation, the type-twice rule and the audit row all live here so that no
 * route can store an identity the reader would refuse, change a statutory
 * number from a single keystroke-level slip, or change one without evidence.
 */
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import {
  DATE_FIELDS,
  LENDER_IDENTITY_FIELDS,
  LENDER_IDENTITY_SELECT,
  STATUTORY_FIELDS,
  storedDateString,
  validateLenderIdentityColumns,
  type LenderIdentityColumns,
} from "./identity"

type StatutoryField = (typeof STATUTORY_FIELDS)[number]
type ConfirmField = `${StatutoryField}Confirm`

export type LenderIdentityWriteErrors = Partial<Record<keyof LenderIdentityColumns | ConfirmField | "form", string>>

export type LenderIdentityWriteResult =
  | { ok: true; changed: boolean; identity: LenderIdentityColumns }
  | { ok: false; errors: LenderIdentityWriteErrors }

/** The app's Prisma client (or a test double with the same transaction shape). */
export type IdentityWriteDb = Pick<typeof prisma, "$transaction">

const LABEL: Record<StatutoryField, string> = {
  ncrNumber: "NCR registration number",
  fscaNumber: "FSP licence number",
  companyRegNumber: "company registration number",
}

/** Same normalisation the schema applies, so " ncrcp1 " confirms "NCRCP1". */
function normaliseStatutory(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toUpperCase()
  return trimmed === "" ? null : trimmed
}

/** Column values as Prisma writes them: a DATE column takes a `Date` at UTC midnight. */
function toWrite(columns: Partial<LenderIdentityColumns>): Record<string, string | Date | null> {
  const out: Record<string, string | Date | null> = { ...columns }
  for (const field of DATE_FIELDS) {
    const value = columns[field]
    if (value) out[field] = new Date(`${value}T00:00:00.000Z`)
  }
  return out
}

/**
 * Replace the tenant's identity with `input` (every identity column; the
 * form always sends all of them). Returns per-field errors and writes
 * nothing when invalid. A change and its `LENDER_IDENTITY_UPDATED` audit row
 * commit in one transaction, or neither does. An unchanged submission writes
 * and audits nothing.
 */
export async function updateLenderIdentity(
  db: IdentityWriteDb,
  args: {
    tenantId: string
    actor: { id: string; email: string }
    input: unknown
    ipAddress?: string
  },
): Promise<LenderIdentityWriteResult> {
  const { tenantId, actor, input, ipAddress } = args
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { form: "Request body must be an object." } }
  }
  const body = input as Record<string, unknown>
  const parsed = validateLenderIdentityColumns(
    Object.fromEntries(LENDER_IDENTITY_FIELDS.map((field) => [field, body[field] ?? null])),
  )
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const next = parsed.columns

  return db.$transaction(async (tx) => {
    // Lock the row, then read it, so the type-twice comparison and the
    // audited "old" values are exactly the state this write replaces even
    // under concurrent saves. (No row yet: a concurrent first save fails on
    // the tenantId unique key instead.)
    await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
    const stored = await tx.tenantConfig.findUnique({ where: { tenantId }, select: LENDER_IDENTITY_SELECT })
    const prev = Object.fromEntries(
      LENDER_IDENTITY_FIELDS.map((field) => [field, storedDateString(stored?.[field]) ?? null]),
    ) as LenderIdentityColumns

    const errors: LenderIdentityWriteErrors = {}
    for (const field of STATUTORY_FIELDS) {
      if (next[field] === prev[field]) continue
      if (normaliseStatutory(body[`${field}Confirm`]) !== next[field]) {
        errors[`${field}Confirm`] = `Re-type the ${LABEL[field]} exactly to confirm the change.`
      }
    }
    // A lender with no FSP number offers no insurance. The database treats an
    // active credit-life product as an offer when it approves an application,
    // so the number cannot be cleared while one is active.
    if (prev.fscaNumber && !next.fscaNumber) {
      const offered = await tx.insuranceProduct.count({ where: { tenantId, type: "CREDIT_LIFE", active: true } })
      if (offered > 0) {
        errors.fscaNumber = "Deactivate the credit-life products first (Settings → Products → Insurance): a lender without an FSP licence number offers no cover."
      }
    }
    if (Object.keys(errors).length > 0) return { ok: false as const, errors }

    const changedFields = LENDER_IDENTITY_FIELDS.filter((field) => next[field] !== prev[field])
    if (changedFields.length === 0) return { ok: true as const, changed: false, identity: prev }

    const update = Object.fromEntries(changedFields.map((field) => [field, next[field]]))
    await tx.tenantConfig.upsert({
      where: { tenantId },
      update: toWrite(update),
      create: { tenantId, ...toWrite(next) },
    })
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.LENDER_IDENTITY_UPDATED,
      entity: "TenantConfig",
      entityId: tenantId,
      oldValue: Object.fromEntries(changedFields.map((field) => [field, prev[field]])),
      newValue: update,
      ipAddress,
    }, tx)
    return { ok: true as const, changed: true, identity: next }
  })
}
