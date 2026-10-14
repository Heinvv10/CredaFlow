import { randomBytes } from "node:crypto"
/**
 * The people and entities of the asset-finance demo seed: four synthetic
 * clients, a trust and a company, and their relationships. Entities and
 * relationships are validated by the same parsers as the staff routes
 * (parseBusinessEntityInput, parseRelationshipInput) and audited with the
 * same actions. Idempotent: existing rows are found and kept.
 */
import type { BusinessEntityType, EntityRole, TrusteeKind } from "@prisma/client"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { parseBusinessEntityInput } from "@/lib/asset-finance/entity-input"
import { parseRelationshipInput, relationshipRowValues } from "@/lib/asset-finance/relationship-input"
import type { SeedActor } from "./asset-finance-documents"
import { PEOPLE, personEmail, type AfPersonKey } from "./asset-finance-data"

/** The four synthetic clients, by key. KYC stays PENDING: no verification is claimed. */
export async function ensurePeople(tenantId: string): Promise<Record<AfPersonKey, string>> {
  const ids = {} as Record<AfPersonKey, string>
  for (const p of PEOPLE) {
    // idNumber is globally unique: refuse rather than rewrite another tenant's client.
    const existing = await withoutTenantScope(async () =>
      await prisma.client.findUnique({ where: { idNumber: p.idNumber }, select: { id: true, tenantId: true } }),
    )
    if (existing && existing.tenantId !== tenantId) {
      throw new Error(`Seed refused: client with ID number ${p.idNumber} belongs to another tenant (${existing.tenantId}). The demo seed never rewrites another tenant's row.`)
    }
    const envPassword = p.portalPasswordEnv ? process.env[p.portalPasswordEnv] || undefined : undefined
    if (existing) {
      if (envPassword) {
        await prisma.client.update({ where: { id: existing.id }, data: { portalPassword: await bcrypt.hash(envPassword, 12) } })
      }
      if (p.key === "director") await prisma.client.update({ where: { id: existing.id }, data: {
        monthlyIncome: 12_000_000, monthlyExpenses: 3_000_000, popiaConsentGiven: true, popiaConsentAt: new Date(),
      } })
      ids[p.key] = existing.id
      continue
    }
    const portalPassword = p.portalPasswordEnv ? envPassword ?? `Demo-${randomBytes(12).toString("base64url")}!` : null
    if (portalPassword && !envPassword && process.env.SEED_PRINT_CREDENTIALS === "1") {
      console.log(`Portal login ${personEmail(p)}: ${portalPassword}`)
    }
    const created = await prisma.client.create({
      data: {
        tenantId, reference: p.reference, idNumber: p.idNumber, firstName: p.firstName, lastName: p.lastName,
        dateOfBirth: new Date(p.dob), gender: p.gender, email: personEmail(p), phone: p.phone, whatsapp: p.phone,
        addressLine1: "1 Test Street", city: "Testville", province: "Gauteng", postalCode: "0001",
        employmentStatus: "SELF_EMPLOYED", kycStatus: "PENDING",
        monthlyIncome: p.key === "director" ? 12_000_000 : 0,
        monthlyExpenses: p.key === "director" ? 3_000_000 : 0,
        popiaConsentGiven: p.key === "director", popiaConsentAt: p.key === "director" ? new Date() : null,
        portalPassword: portalPassword ? await bcrypt.hash(portalPassword, 12) : null,
      },
      select: { id: true },
    })
    ids[p.key] = created.id
  }
  return ids
}

/** The entity with this type and registration number, created (and audited) if missing. */
export async function ensureEntity(tenantId: string, actor: SeedActor, body: Record<string, unknown>): Promise<{ id: string; type: BusinessEntityType }> {
  const input = parseBusinessEntityInput(body)
  if ("errors" in input) throw new Error(`Seed entity refused: ${JSON.stringify(input.errors)}`)
  const { data } = input
  const existing = await prisma.businessEntity.findFirst({
    where: { tenantId, type: data.type, registrationNumber: data.registrationNumber },
    select: { id: true, type: true },
  })
  if (existing) return existing
  return prisma.$transaction(async (tx) => {
    const created = await tx.businessEntity.create({
      data: { tenantId, ...data, createdById: actor.id },
      select: { id: true, type: true },
    })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email,
      action: AuditAction.BUSINESS_ENTITY_CREATED, entity: "BusinessEntity", entityId: created.id,
      newValue: {
        type: data.type, legalName: data.legalName, registrationNumber: data.registrationNumber,
        annualTurnover: data.annualTurnover, totalAssetValue: data.totalAssetValue,
        financialYearEnd: data.financialYearEnd?.toISOString().slice(0, 10) ?? null,
      },
    }, tx)
    return created
  })
}

/** Link a client to the entity in each role it does not hold yet (one audited row per role). */
export async function linkPerson(
  tenantId: string,
  actor: SeedActor,
  entity: { id: string; type: BusinessEntityType },
  clientId: string,
  roles: EntityRole[],
  trusteeKind: TrusteeKind | null = null,
): Promise<void> {
  const input = parseRelationshipInput({ clientId, roles, trusteeKind }, entity.type)
  if ("errors" in input) throw new Error(`Seed relationship refused: ${JSON.stringify(input.errors)}`)
  await prisma.$transaction(async (tx) => {
    const held = await tx.entityRelationship.findMany({
      where: { tenantId, entityId: entity.id, clientId, role: { in: input.data.roles } },
      select: { role: true },
    })
    for (const role of input.data.roles.filter((r) => !held.some((h) => h.role === r))) {
      const values = relationshipRowValues(input.data, role)
      const row = await tx.entityRelationship.create({
        data: { tenantId, entityId: entity.id, clientId, role, ...values },
        select: { id: true },
      })
      await logAuditStrict({
        tenantId, userId: actor.id, userEmail: actor.email,
        action: AuditAction.ENTITY_RELATIONSHIP_ADDED, entity: "EntityRelationship", entityId: row.id,
        newValue: { businessEntityId: entity.id, clientId, role, ...values, reactivated: false },
      }, tx)
    }
  })
}
