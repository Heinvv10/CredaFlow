import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { lockAffordabilityTenantPolicy } from "@/lib/affordability/evidence-locks"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import {
  isEnvCredentialsTenant,
  maskCredential,
  CredentialInputError,
  sealCredential,
  SEALED_CREDENTIAL_FIELDS,
  type SealedCredentialField,
} from "@/lib/integrations/tenant-credentials"

// Registry keys from lib/integrations/collections/registry.ts, plus null (= off).
const VALID_COLLECTION_PROVIDERS = [null, "netcash"]

// The lender's Stitch collection account: not secret, stored as typed.
const STITCH_BENEFICIARY_FIELDS = ["stitchBeneficiaryName", "stitchBankId", "stitchAccountNumber", "stitchBranchCode"] as const
// Every field that decides where money is paid out or collected from:
// Stitch (receipts), Netcash (payouts, debit orders) and the collection rail.
const TOTP_GATED_FIELDS = [
  "stitchKey", "stitchWebhookSecret", ...STITCH_BENEFICIARY_FIELDS,
  "netcashKey", "netcashDebitOrderKey", "collectionProvider",
] as const

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
      // tenant that owns them (ENV_CREDENTIALS_TENANT_SLUG, lib/integrations/tenant-credentials.ts).
      const experianConfigured = !!config?.experianKey ||
        (!!(process.env.EXPERIAN_USERNAME && process.env.EXPERIAN_PASSWORD) && await isEnvCredentialsTenant(tenant.id))
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

      // What this request writes, decided once: the 2FA gate below and the
      // write read the same object, so nothing the gate does not see is
      // written. Own properties only; credentials are stored exactly as given
      // (any non-empty string), payee fields trimmed (blank is no change).
      const given = (key: string): string | null =>
        body !== null && typeof body === "object" && Object.hasOwn(body, key) && typeof body[key] === "string"
          ? body[key]
          : null
      const credentialWrites: Partial<Record<SealedCredentialField, string>> = {}
      for (const key of SEALED_CREDENTIAL_FIELDS) {
        const value = given(key)
        if (value !== null && value.length > 0) credentialWrites[key] = value
      }
      for (const key of STITCH_BENEFICIARY_FIELDS) {
        const value = given(key)?.trim()
        if (value) updates[key] = value
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

      // Where borrowers' money is paid or collected is as sensitive as the
      // lender's identity (PUT /api/settings/identity): changing it takes a
      // sign-in that verified a TOTP code, wherever the lender requires 2FA.
      const moneyRouteTouched = TOTP_GATED_FIELDS.some((key) => key in credentialWrites || key in updates)
      if (moneyRouteTouched && guard.user.totpVerified !== true && await isStaffTotpRequired(tenant.id)) {
        return NextResponse.json(
          { error: "Sign in with two-factor authentication to change where payments are made or collected. Enable it under Settings → Security, then sign out and back in." },
          { status: 403 },
        )
      }

      // Sealed on the way in (lib/integrations/tenant-credentials.ts); a
      // deployment without the key refuses rather than store plaintext.
      for (const [key, value] of Object.entries(credentialWrites) as Array<[SealedCredentialField, string]>) {
        try {
          updates[key] = sealCredential(value)
        } catch (e) {
          if (e instanceof CredentialInputError) {
            return NextResponse.json({ error: `${key}: enter the credential itself, not a sealed value` }, { status: 400 })
          }
          console.error("Refusing to store a provider credential:", e)
          return NextResponse.json({ error: "Credential encryption is not configured on this deployment" }, { status: 500 })
        }
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
        // The payee account is not secret: its change is audited old -> new.
        const payeeKeys = STITCH_BENEFICIARY_FIELDS.filter((key) => key in updates)
        const before = payeeKeys.length > 0
          ? await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: Object.fromEntries(payeeKeys.map((k) => [k, true])) })
          : null
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
            ...(payeeKeys.length > 0
              ? { oldValue: Object.fromEntries(payeeKeys.map((k) => [k, (before as Record<string, string | null> | null)?.[k] ?? null])) }
              : {}),
            newValue: {
              updatedKeys: Object.keys(keyUpdates),
              ...Object.fromEntries(payeeKeys.map((k) => [k, updates[k]])),
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
