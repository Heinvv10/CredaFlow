/**
 * Creates a lender's Tenant and TenantConfig from a validated config file
 * (tenant-config.ts). Create-only: an existing tenant is never rewritten, so a
 * statutory number cannot change without Settings > Lender identity's
 * type-twice rule and its audit row. Rerunning with an identical file is a
 * no-op that still re-ensures the default document and message templates.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditDb } from "./audit-db"
import { DATE_FIELDS, LENDER_IDENTITY_FIELDS, storedDateString } from "@/lib/config/identity-schema"
import { TENANT_COLOUR_VARS } from "@/lib/theme/tenant-colours"
import { FEATURE_COLUMNS, type TenantBootstrapConfig } from "./tenant-config"

export type TenantRefusalCode = "TENANT_DIFFERS" | "DOMAIN_IN_USE"

export class TenantBootstrapRefusal extends Error {
  readonly code: TenantRefusalCode
  constructor(code: TenantRefusalCode, message: string) {
    super(message)
    this.name = "TenantBootstrapRefusal"
    this.code = code
  }
}

export type TenantBootstrapOptions = {
  dryRun: boolean
  operator: string
  /** Seeds the default document and message templates (idempotent). */
  seedTemplates: (tenantId: string, brandName: string) => Promise<void>
  /** The Operator that runs the lender; unset, the database default (the root operator). */
  operatorId?: string
  /** The signed-in operator user creating it (the console); unset, the CLI is the actor. */
  actor?: { userId: string; email: string }
}

export type TenantBootstrapResult =
  | { status: "created" | "unchanged"; tenantId: string }
  | { status: "dry-run-create" | "dry-run-unchanged"; tenantId: string | null }

const SOURCE = "lender:bootstrap-tenant"
const COLOUR_FIELDS = Object.keys(TENANT_COLOUR_VARS) as (keyof typeof TENANT_COLOUR_VARS)[]
const FEATURE_FIELDS = Object.values(FEATURE_COLUMNS).map(([column]) => column)
const COMPARED_CONFIG_SELECT = Object.fromEntries(
  [...COLOUR_FIELDS, ...FEATURE_FIELDS, ...LENDER_IDENTITY_FIELDS].map((f) => [f, true]),
) as Prisma.TenantConfigSelect

/** Column values as Prisma writes them: a DATE column takes a Date at UTC midnight. */
function configColumns(c: TenantBootstrapConfig): Record<string, unknown> {
  const identity: Record<string, unknown> = { ...c.identity }
  for (const f of DATE_FIELDS) if (c.identity[f]) identity[f] = new Date(`${c.identity[f]}T00:00:00.000Z`)
  return { ...c.colours, ...c.features, ...identity }
}

/** Names (never values) of what differs between the stored tenant and the file. */
function differences(stored: { name: string; domain: string | null; config: Record<string, unknown> | null }, c: TenantBootstrapConfig): string[] {
  const out: string[] = []
  if (stored.name !== c.name) out.push("name")
  if (stored.domain !== c.domain) out.push("domain")
  if (!stored.config) return [...out, "config (no TenantConfig row)"]
  const want = c as unknown as Record<string, Record<string, unknown>>
  for (const f of COLOUR_FIELDS) if (stored.config[f] !== want.colours[f]) out.push(f)
  for (const f of FEATURE_FIELDS) if (stored.config[f] !== want.features[f]) out.push(f)
  for (const f of LENDER_IDENTITY_FIELDS) {
    if ((storedDateString(stored.config[f]) ?? null) !== (want.identity[f] ?? null)) out.push(f)
  }
  return out
}

export async function bootstrapTenant(db: PrismaClient, c: TenantBootstrapConfig, opts: TenantBootstrapOptions): Promise<TenantBootstrapResult> {
  const outcome = await db.$transaction(async (tx): Promise<TenantBootstrapResult> => {
    // Only the columns differences() compares: TenantConfig also holds sealed
    // provider credentials, which this has no reason to read.
    const stored = await tx.tenant.findUnique({ where: { slug: c.slug }, include: { config: { select: COMPARED_CONFIG_SELECT } } })
    if (stored) {
      const diff = differences(stored as never, c)
      if (diff.length > 0) {
        throw new TenantBootstrapRefusal(
          "TENANT_DIFFERS",
          `Tenant "${c.slug}" already exists and differs from the file in: ${diff.join(", ")}. This command only creates; change a live lender through Settings (identity changes need the numbers typed twice and are audited).`,
        )
      }
      return { status: opts.dryRun ? "dry-run-unchanged" : "unchanged", tenantId: stored.id }
    }
    if (c.domain && (await tx.tenant.findUnique({ where: { domain: c.domain } }))) {
      throw new TenantBootstrapRefusal("DOMAIN_IN_USE", `Domain ${c.domain} already belongs to another tenant.`)
    }
    if (opts.dryRun) return { status: "dry-run-create", tenantId: null }

    const created = await tx.tenant.create({
      data: {
        slug: c.slug, name: c.name, domain: c.domain, status: "ACTIVE",
        ...(opts.operatorId ? { operatorId: opts.operatorId } : {}),
        config: { create: configColumns(c) as Prisma.TenantConfigCreateWithoutTenantInput },
      },
    })
    const by = { userId: opts.actor?.userId, userEmail: opts.actor?.email ?? SOURCE }
    await logAuditStrict({
      tenantId: created.id, ...by, action: AuditAction.TENANT_CREATED, entity: "Tenant", entityId: created.id,
      newValue: { slug: c.slug, name: c.name, domain: c.domain, status: "ACTIVE", ...c.colours, ...c.features, operator: opts.operator },
    }, auditDb(tx))
    await logAuditStrict({
      tenantId: created.id, ...by, action: AuditAction.LENDER_IDENTITY_UPDATED, entity: "TenantConfig", entityId: created.id,
      oldValue: {}, newValue: { ...c.identity, operator: opts.operator },
    }, auditDb(tx))
    return { status: "created", tenantId: created.id }
  })

  // Outside the transaction: idempotent, and a failure leaves a tenant a rerun completes.
  if ((outcome.status === "created" || outcome.status === "unchanged") && outcome.tenantId) {
    await opts.seedTemplates(outcome.tenantId, c.identity.brandName ?? c.name)
  }
  return outcome
}
