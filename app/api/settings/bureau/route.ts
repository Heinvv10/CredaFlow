import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { lockAffordabilityTenantPolicy } from "@/lib/affordability/evidence-locks"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { DEFAULT_BUREAU_MAX_AGE_DAYS, isApprovalBureau } from "@/lib/compliance/bureau"
import {
  BureauCredentialsError,
  mergeBureauCredentials,
  openBureauCredentials,
  sealBureauCredentials,
} from "@/lib/bureau/credentials"
import { registeredBureaus } from "@/lib/bureau/registry"
import { parseBureauSettingsInput } from "@/lib/bureau/settings-input"

// The tenant's bureau ENQUIRY settings (lib/bureau): the provider order, the
// report freshness window approval honours, and sealed per-bureau credentials.
// ADMIN (SUPER_ADMIN included). Writes need a TOTP-verified session whenever
// the lender requires staff 2FA. Credentials are write-only: a read says which
// bureaus have them, never what they are.

const SELECT = { bureauProviderOrder: true, bureauMaxAgeDays: true, bureauCredentials: true } as const
const DEFAULT_ORDER = ["experian"]

type Row = { bureauProviderOrder: string[]; bureauMaxAgeDays: number; bureauCredentials: string | null } | null

/** Which bureaus have stored credentials. Null when they cannot be opened here (no key). */
function configuredIds(row: Row): string[] | null {
  try {
    return Object.keys(openBureauCredentials(row?.bureauCredentials ?? null)).sort()
  } catch (error) {
    if (error instanceof BureauCredentialsError) return null
    throw error
  }
}

function view(row: Row) {
  const configured = configuredIds(row)
  return {
    bureauProviderOrder: row?.bureauProviderOrder ?? DEFAULT_ORDER,
    bureauMaxAgeDays: row?.bureauMaxAgeDays ?? DEFAULT_BUREAU_MAX_AGE_DAYS,
    credentialsReadable: configured !== null,
    providers: registeredBureaus().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      implemented: p.capabilities.implemented,
      approvalBureau: isApprovalBureau(p.id),
      credentialFields: [...p.credentialFields],
      credentialsConfigured: configured?.includes(p.id) ?? false,
    })),
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const row = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
      return NextResponse.json(view(row))
    } catch (e) {
      console.error("Failed to load bureau settings:", e instanceof Error ? e.name : "unknown")
      return NextResponse.json({ error: "Failed to load the bureau settings" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if ((await isStaffTotpRequired(tenant.id)) && guard.user.totpVerified !== true) {
      return NextResponse.json(
        { error: "Sign in with two-factor authentication to change the bureau settings. Enable it under Settings → Security, then sign out and back in." },
        { status: 403 },
      )
    }
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }
    const parsed = parseBureauSettingsInput(body, registeredBureaus())
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { credentials, ...plain } = parsed.values

    try {
      const row = await prisma.$transaction(async (tx) => {
        // The freshness window decides which bureau checks approval accepts:
        // serialise with final lending decisions, like the credit policy.
        await lockAffordabilityTenantPolicy(tx, { tenantId: tenant.id })
        const prev = await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
        const data: { bureauProviderOrder?: string[]; bureauMaxAgeDays?: number; bureauCredentials?: string | null } = { ...plain }
        if (credentials) {
          const next = mergeBureauCredentials(openBureauCredentials(prev?.bureauCredentials ?? null), credentials)
          data.bureauCredentials = Object.keys(next).length > 0 ? sealBureauCredentials(next) : null
        }
        const saved = await tx.tenantConfig.upsert({
          where: { tenantId: tenant.id },
          update: data,
          create: { tenantId: tenant.id, ...data },
          select: SELECT,
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.BUREAU_ENQUIRY_CONFIG_UPDATED,
          entity: "TenantConfig",
          entityId: tenant.id,
          ipAddress: callerIp(req),
          // Identifiers only: a credential value never reaches an audit row.
          oldValue: {
            bureauProviderOrder: prev?.bureauProviderOrder ?? DEFAULT_ORDER,
            bureauMaxAgeDays: prev?.bureauMaxAgeDays ?? DEFAULT_BUREAU_MAX_AGE_DAYS,
            credentialsConfigured: configuredIds(prev),
          },
          newValue: {
            ...plain,
            ...(credentials
              ? {
                  credentialsSet: Object.keys(credentials).filter((id) => credentials[id] !== null).sort(),
                  credentialsRemoved: Object.keys(credentials).filter((id) => credentials[id] === null).sort(),
                }
              : {}),
          },
        }, tx)
        return saved
      })
      return NextResponse.json(view(row))
    } catch (e) {
      if (e instanceof BureauCredentialsError) {
        return NextResponse.json({ error: `Bureau credentials cannot be stored: ${e.message}` }, { status: 503 })
      }
      console.error("Failed to update bureau settings:", e instanceof Error ? e.name : "unknown")
      return NextResponse.json({ error: "Failed to update the bureau settings" }, { status: 500 })
    }
  })
}
