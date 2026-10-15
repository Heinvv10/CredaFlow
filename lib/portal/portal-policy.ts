/**
 * The lender's client-portal switches (TenantConfig):
 *
 *  - featurePortal: the portal exists at all. Off: portal sign-in is refused
 *    (lib/auth.ts), live client sessions end (lib/client-session.ts), the
 *    public portal APIs answer 404 and the portal pages show an
 *    "unavailable" page. The payment webhook is deliberately unaffected:
 *    money already in flight must still be recorded.
 *  - allowNewRegistrations: self-registration (/api/portal/register). Off
 *    refuses new activations only; clients who already activated sign in.
 *  - requireSigningOtp / signingOtpBranchExempt: lib/signing-otp/policy.ts.
 *
 * featurePortal is written by the tenant admin API; the other three by
 * applyPortalPolicy below (Settings → Security & KYC policy).
 */
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

export type PortalPolicy = {
  portalEnabled: boolean
  allowNewRegistrations: boolean
  requireSigningOtp: boolean
  signingOtpBranchExempt: boolean
}

/** Schema defaults, which also apply to a tenant with no config row. */
export const PORTAL_POLICY_DEFAULTS: PortalPolicy = {
  portalEnabled: true,
  allowNewRegistrations: true,
  requireSigningOtp: true,
  signingOtpBranchExempt: true,
}

export async function getPortalPolicy(tenantId: string): Promise<PortalPolicy> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { featurePortal: true, allowNewRegistrations: true, requireSigningOtp: true, signingOtpBranchExempt: true },
  })
  // `??` and not a plain read: a column a caller did not get back is the
  // default, never "off".
  return {
    portalEnabled: config?.featurePortal ?? PORTAL_POLICY_DEFAULTS.portalEnabled,
    allowNewRegistrations: config?.allowNewRegistrations ?? PORTAL_POLICY_DEFAULTS.allowNewRegistrations,
    requireSigningOtp: config?.requireSigningOtp ?? PORTAL_POLICY_DEFAULTS.requireSigningOtp,
    signingOtpBranchExempt: config?.signingOtpBranchExempt ?? PORTAL_POLICY_DEFAULTS.signingOtpBranchExempt,
  }
}

export async function isPortalEnabled(tenantId: string): Promise<boolean> {
  return (await getPortalPolicy(tenantId)).portalEnabled
}

export const PORTAL_UNAVAILABLE_MESSAGE = "The client portal is not available. Please contact your lender."

export const REGISTRATIONS_CLOSED_MESSAGE =
  "New portal registrations are closed. If you already have a portal account, sign in; otherwise contact your lender."

/** The answer every portal API gives while the portal is off. */
export function portalUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: PORTAL_UNAVAILABLE_MESSAGE, portal: "disabled" }, { status: 404 })
}

/** Null while the portal is on; otherwise the refusal for a public portal API. */
export async function portalOffRefusal(tenantId: string): Promise<NextResponse | null> {
  return (await isPortalEnabled(tenantId)) ? null : portalUnavailableResponse()
}

/**
 * Null when a new portal account may be activated. A lender-wide answer, so
 * it says nothing about whether any account exists.
 */
export async function portalRegistrationRefusal(tenantId: string): Promise<NextResponse | null> {
  const policy = await getPortalPolicy(tenantId)
  if (!policy.portalEnabled) return portalUnavailableResponse()
  if (!policy.allowNewRegistrations) {
    return NextResponse.json({ error: REGISTRATIONS_CLOSED_MESSAGE, portal: "registrations_closed" }, { status: 403 })
  }
  return null
}

type PolicyTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

export type PortalPolicyUpdate = Pick<PortalPolicy, "allowNewRegistrations" | "requireSigningOtp" | "signingOtpBranchExempt">

/**
 * Set the three settings-page switches inside the caller's transaction (which
 * has checked the actor). Serialised per tenant; the change and its audit row
 * commit together; an unchanged value writes and audits nothing.
 */
export async function applyPortalPolicy(
  tx: PolicyTx,
  args: { tenantId: string; actor: { id: string; email: string }; next: PortalPolicyUpdate; ipAddress?: string },
): Promise<{ changed: boolean; policy: PortalPolicyUpdate }> {
  const { tenantId, actor, next, ipAddress } = args
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portal-policy:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const stored = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: { allowNewRegistrations: true, requireSigningOtp: true, signingOtpBranchExempt: true },
  })
  const previous: PortalPolicyUpdate = stored ?? {
    allowNewRegistrations: PORTAL_POLICY_DEFAULTS.allowNewRegistrations,
    requireSigningOtp: PORTAL_POLICY_DEFAULTS.requireSigningOtp,
    signingOtpBranchExempt: PORTAL_POLICY_DEFAULTS.signingOtpBranchExempt,
  }
  const changed = (Object.keys(next) as (keyof PortalPolicyUpdate)[]).some((k) => previous[k] !== next[k])
  if (!changed) return { changed: false, policy: previous }

  await tx.tenantConfig.upsert({ where: { tenantId }, update: next, create: { tenantId, ...next } })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.PORTAL_POLICY_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: previous,
    newValue: next,
    ipAddress,
  }, tx)
  return { changed: true, policy: next }
}
