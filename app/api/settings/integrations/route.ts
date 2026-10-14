import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { lockAffordabilityTenantPolicy } from "@/lib/affordability/evidence-locks"
import {
  isTheSingleActiveTenant,
  maskCredential,
  sealCredential,
  SEALED_CREDENTIAL_FIELDS,
  type SealedCredentialField,
} from "@/lib/integrations/tenant-credentials"

// Registry keys from lib/integrations/collections/registry.ts, plus null (= off).
const VALID_COLLECTION_PROVIDERS = [null, "netcash"]

// The lender's Stitch collection account: not secret, stored as typed.
const STITCH_BENEFICIARY_FIELDS = ["stitchBeneficiaryName", "stitchBankId", "stitchAccountNumber", "stitchBranchCode"] as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          ...Object.fromEntries(SEALED_CREDENTIAL_FIELDS.map((key) => [key, true])),
          ...Object.fromEntries(STITCH_BENEFICIARY_FIELDS.map((key) => [key, true])),
          collectionsEngineEnabled: true,
          collectionProvider: true,
          avsProvider: true,
        },
      }) as (Record<string, string | null> & {
        collectionsEngineEnabled: boolean
        collectionProvider: string | null
        avsProvider: string | null
      }) | null

      // Per-tenant first; the EXPERIAN_* environment pair only counts on a
      // single-tenant deployment, for its one ACTIVE tenant (lib/integrations/tenant-credentials.ts).
      const experianConfigured = !!config?.experianKey ||
        (!!(process.env.EXPERIAN_USERNAME && process.env.EXPERIAN_PASSWORD) && await isTheSingleActiveTenant(tenant.id))
      const experianEnv = (process.env.EXPERIAN_ENV ?? "UAT").toUpperCase()

      // Credentials are masked whole: whether one is set, never any of it.
      const masked = Object.fromEntries(SEALED_CREDENTIAL_FIELDS.flatMap((key) => [
        [key, maskCredential(config?.[key])],
        [`${key.replace(/Key$|Secret$/, "")}Configured`, !!config?.[key]],
      ]))

      return NextResponse.json({
        ...masked,
        ...Object.fromEntries(STITCH_BENEFICIARY_FIELDS.map((key) => [key, config?.[key] ?? null])),
        collectionsEngineEnabled: config?.collectionsEngineEnabled ?? false,
        collectionProvider: config?.collectionProvider ?? null,
        avsProvider: config?.avsProvider ?? null,
        experianConfigured,
        experianEnv,
      })
    } catch (e) {
      console.error("Failed to load integration config:", e)
      return NextResponse.json({ error: "Failed to load config" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const body = await req.json()
      const updates: Partial<Record<SealedCredentialField | (typeof STITCH_BENEFICIARY_FIELDS)[number], string>> & {
        collectionsEngineEnabled?: boolean
        collectionProvider?: string | null
        avsProvider?: string | null
      } = {}

      // Sealed on the way in (lib/integrations/tenant-credentials.ts); a
      // deployment without the key refuses rather than store plaintext.
      for (const key of SEALED_CREDENTIAL_FIELDS) {
        if (typeof body[key] === "string" && body[key].length > 0) {
          try {
            updates[key] = sealCredential(body[key])
          } catch (e) {
            console.error("Refusing to store a provider credential:", e)
            return NextResponse.json({ error: "Credential encryption is not configured on this deployment" }, { status: 500 })
          }
        }
      }
      for (const key of STITCH_BENEFICIARY_FIELDS) {
        if (typeof body[key] === "string" && body[key].trim().length > 0) {
          updates[key] = body[key].trim()
        }
      }

      if (!VALID_COLLECTION_PROVIDERS.includes(body.collectionProvider ?? null)) {
        return NextResponse.json({ error: "Unknown collection provider" }, { status: 400 })
      }
      if (!VALID_COLLECTION_PROVIDERS.includes(body.avsProvider ?? null)) {
        return NextResponse.json({ error: "Unknown AVS provider" }, { status: 400 })
      }

      if ("collectionsEngineEnabled" in body) {
        updates.collectionsEngineEnabled = body.collectionsEngineEnabled === true
      }
      if ("collectionProvider" in body) {
        updates.collectionProvider = body.collectionProvider ?? null
      }
      if ("avsProvider" in body) {
        updates.avsProvider = body.avsProvider ?? null
      }

      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
      }

      // Audit which fields changed — never the credential values themselves
      // (the audit-log viewer is visible to LOAN_ADMIN; keys are ADMIN-only).
      const { collectionsEngineEnabled, collectionProvider, avsProvider, ...keyUpdates } = updates
      await prisma.$transaction(async (tx) => {
        // Disbursement treats a missing TenantConfig row as all lending gates
        // disabled. Coordinate the first insert as well as later updates so an
        // admin cannot enable AVS after payout has read the defaults but before
        // the loan commits.
        await lockAffordabilityTenantPolicy(tx, { tenantId: tenant.id })
        await tx.tenantConfig.upsert({
          where: { tenantId: tenant.id },
          update: updates,
          create: { tenantId: tenant.id, ...updates },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "INTEGRATION_SETTINGS_UPDATED",
            entity: "TenantConfig",
            entityId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            newValue: {
              updatedKeys: Object.keys(keyUpdates),
              ...("collectionsEngineEnabled" in updates ? { collectionsEngineEnabled } : {}),
              ...("collectionProvider" in updates ? { collectionProvider } : {}),
              ...("avsProvider" in updates ? { avsProvider } : {}),
            },
            ipAddress: callerIp(req),
          },
        })
      })

      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error("Failed to update integration config:", e)
      return NextResponse.json({ error: "Failed to update config" }, { status: 500 })
    }
  })
}
