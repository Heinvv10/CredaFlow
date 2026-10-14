import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { lockAffordabilityTenantPolicy } from "@/lib/affordability/evidence-locks"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { SIMULATED_PROVIDER_ID } from "@/lib/integrations/collections/simulated"
import { providerSwitchBlockers } from "@/lib/collections-engine/provider-switch"
import { auditRefusal } from "@/lib/audit-refusals"
import { AuditAction } from "@/lib/audit"

// Registry keys from lib/integrations/collections/registry.ts, plus null (= off).
const VALID_COLLECTION_PROVIDERS = [null, "netcash", SIMULATED_PROVIDER_ID]

function maskKey(value: string | null): string {
  if (!value) return ""
  if (value.length <= 4) return "****"
  return value.slice(0, 4) + "****"
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          bulkSmsKey: true,
          netcashKey: true,
          transunionKey: true,
          smileIdentityKey: true,
          collectionsEngineEnabled: true,
          collectionProvider: true,
          avsProvider: true,
          netcashDebitOrderKey: true,
          netcashRiskReportsKey: true,
        },
      })

      // Experian credentials live in .env (EXPERIAN_*), not TenantConfig — a
      // runtime form cannot write .env, so this is read-only status only.
      const experianConfigured = !!(process.env.EXPERIAN_USERNAME && process.env.EXPERIAN_PASSWORD)
      const experianEnv = (process.env.EXPERIAN_ENV ?? "UAT").toUpperCase()

      return NextResponse.json({
        bulkSmsKey: maskKey(config?.bulkSmsKey ?? null),
        netcashKey: maskKey(config?.netcashKey ?? null),
        transunionKey: maskKey(config?.transunionKey ?? null),
        smileIdentityKey: maskKey(config?.smileIdentityKey ?? null),
        netcashDebitOrderKey: maskKey(config?.netcashDebitOrderKey ?? null),
        netcashRiskReportsKey: maskKey(config?.netcashRiskReportsKey ?? null),
        bulkSmsConfigured: !!config?.bulkSmsKey,
        netcashConfigured: !!config?.netcashKey,
        transunionConfigured: !!config?.transunionKey,
        smileIdentityConfigured: !!config?.smileIdentityKey,
        netcashDebitOrderConfigured: !!config?.netcashDebitOrderKey,
        netcashRiskReportsConfigured: !!config?.netcashRiskReportsKey,
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
      const allowed = [
        "bulkSmsKey",
        "netcashKey",
        "transunionKey",
        "smileIdentityKey",
        "netcashDebitOrderKey",
        "netcashRiskReportsKey",
      ] as const
      const updates: {
        bulkSmsKey?: string
        netcashKey?: string
        transunionKey?: string
        smileIdentityKey?: string
        netcashDebitOrderKey?: string
        netcashRiskReportsKey?: string
        collectionsEngineEnabled?: boolean
        collectionProvider?: string | null
        avsProvider?: string | null
      } = {}

      for (const key of allowed) {
        if (typeof body[key] === "string" && body[key].length > 0) {
          updates[key] = body[key]
        }
      }

      if (!VALID_COLLECTION_PROVIDERS.includes(body.collectionProvider ?? null)) {
        return NextResponse.json({ error: "Unknown collection provider" }, { status: 400 })
      }
      if (!VALID_COLLECTION_PROVIDERS.includes(body.avsProvider ?? null)) {
        return NextResponse.json({ error: "Unknown AVS provider" }, { status: 400 })
      }
      // Choosing the simulator where it would refuse every call is a
      // misconfiguration: say so now, not at the first collection run.
      if (
        (body.collectionProvider === SIMULATED_PROVIDER_ID || body.avsProvider === SIMULATED_PROVIDER_ID)
        && !isSimulationPermitted("simulated-collections")
      ) {
        return NextResponse.json(
          { error: "The simulated provider is not permitted on this deployment (SIMULATED_INTEGRATIONS)" },
          { status: 422 },
        )
      }

      // Live mandates and in-flight debits are worked against the current
      // provider: switching away would strand them (provider-switch.ts).
      if ("collectionProvider" in body) {
        const requested = body.collectionProvider ?? null
        const blocked = await providerSwitchBlockers(tenant.id, requested)
        if (blocked) {
          await auditRefusal({
            action: AuditAction.COLLECTION_PROVIDER_CHANGE_REFUSED,
            entity: "TenantConfig",
            entityId: tenant.id,
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            reason: "live_collections_on_current_provider",
            status: 409,
            detail: { current: blocked.current, requested, mandates: blocked.mandates, instructions: blocked.instructions },
          })
          return NextResponse.json({
            error: `The collection provider cannot change while ${blocked.current} still holds ${blocked.mandates} live mandate(s) and ${blocked.instructions} open debit(s). Cancel or finish them first.`,
          }, { status: 409 })
        }
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
