import type { SsoConnection } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { openSecret, sealSecret } from "@/lib/crypto/secret-box"
import { parseGroupRoleMap, type GroupRoleMap } from "./groups"
import { parseConnectionInput } from "./connection-input"

/**
 * A lender's SSO connection: read for sign-in, and the one audited write path.
 * The OIDC client secret is sealed with SSO_SECRET_KEY and never leaves this
 * module except to the OIDC client (openClientSecret); the admin view omits it.
 */

export function ssoSecretKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SSO_SECRET_KEY?.trim() || null
}

export type LoadedConnection = Omit<SsoConnection, "groupRoleMap"> & { groupRoleMap: GroupRoleMap }

function load(row: SsoConnection | null): LoadedConnection | null {
  if (!row) return null
  // The CHECK constraints keep an unmappable role out; a stored map that does not parse anyway is empty, never partial.
  return { ...row, groupRoleMap: parseGroupRoleMap(row.groupRoleMap) ?? {} }
}

/** The lender's connection, whether or not it is enabled. Call inside the lender's tenant frame. */
export async function getConnection(tenantId: string): Promise<LoadedConnection | null> {
  return load(await prisma.ssoConnection.findUnique({ where: { tenantId } }))
}

/** The connection only while it is switched on. */
export async function getEnabledConnection(tenantId: string): Promise<LoadedConnection | null> {
  const connection = await getConnection(tenantId)
  return connection?.enabled ? connection : null
}

export function openClientSecret(connection: Pick<SsoConnection, "oidcClientSecretSealed">): string {
  const key = ssoSecretKey()
  if (!key || !connection.oidcClientSecretSealed) throw new Error("SSO_SECRET_KEY is not set or no client secret is stored")
  return openSecret(connection.oidcClientSecretSealed, key)
}

/** The connection as the admin screen shows it: no secret, no certificate body. */
export function connectionView(c: LoadedConnection | null) {
  if (!c) return null
  return {
    protocol: c.protocol, enabled: c.enabled,
    oidc: { issuer: c.oidcIssuer, clientId: c.oidcClientId, hasClientSecret: !!c.oidcClientSecretSealed, scopes: c.oidcScopes },
    saml: { entityId: c.samlEntityId, idpEntityId: c.samlIdpEntityId, idpSsoUrl: c.samlIdpSsoUrl, hasIdpCert: !!c.samlIdpCert },
    emailClaim: c.emailClaim, groupsClaim: c.groupsClaim, allowedEmailDomains: c.allowedEmailDomains, allowUnverifiedEmail: c.allowUnverifiedEmail,
    groupRoleMap: c.groupRoleMap, jitProvisioning: c.jitProvisioning, jitDefaultRole: c.jitDefaultRole,
    trustIdpMfa: c.trustIdpMfa, mfaAcrValues: c.mfaAcrValues, passwordLoginDisabled: c.passwordLoginDisabled,
    updatedAt: c.updatedAt.toISOString(),
  }
}

interface Actor { id: string; email: string; ipAddress?: string }

export type SaveConnectionOutcome =
  | { ok: true; connection: NonNullable<ReturnType<typeof connectionView>> }
  | { ok: false; status: 400 | 503; error: string }

/** Validate and store the connection; the change and its audit row commit together. */
export async function saveConnection(args: { tenantId: string; actor: Actor; body: unknown }): Promise<SaveConnectionOutcome> {
  const key = ssoSecretKey()
  if (!key) return { ok: false, status: 503, error: "Single sign-on is not configured on this server (SSO_SECRET_KEY)." }
  const { tenantId, actor } = args
  return prisma.$transaction(async (tx) => {
    // Serialise writers: the audited old value must be the state replaced.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sso-connection:${tenantId}`}))`
    const existing = await tx.ssoConnection.findUnique({ where: { tenantId } })
    const parsed = parseConnectionInput(args.body, existing)
    if (!parsed.ok) return { ok: false as const, status: 400 as const, error: parsed.error }
    const { value } = parsed
    const sealed = parsed.clientSecret ? sealSecret(parsed.clientSecret, key) : existing?.oidcClientSecretSealed ?? null
    const data = {
      ...value,
      oidcClientSecretSealed: value.protocol === "OIDC" ? sealed : null,
      updatedById: actor.id,
    }
    // Subjects are only meaningful to the provider that issued them: a different issuer, entity id or protocol voids them.
    const providerChanged = existing !== null && providerKey(existing) !== providerKey(value)
    const cleared = providerChanged ? (await tx.ssoIdentity.deleteMany({ where: { tenantId } })).count : 0
    const saved = await tx.ssoConnection.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data })
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.SSO_CONNECTION_UPDATED,
      entity: "SsoConnection",
      entityId: saved.id,
      oldValue: existing ? auditShape(existing) : null,
      newValue: { ...auditShape(saved), clientSecretChanged: parsed.clientSecret !== null, subjectLinksCleared: cleared },
      ipAddress: actor.ipAddress,
    }, tx)
    const loaded = load(saved) as LoadedConnection
    return { ok: true as const, connection: connectionView(loaded) as NonNullable<ReturnType<typeof connectionView>> }
  })
}

const providerKey = (c: { protocol: string; oidcIssuer: string | null; samlIdpEntityId: string | null }) =>
  c.protocol === "OIDC" ? `OIDC|${c.oidcIssuer}` : `SAML|${c.samlIdpEntityId}`

function auditShape(c: SsoConnection) {
  return {
    protocol: c.protocol, enabled: c.enabled, oidcIssuer: c.oidcIssuer, oidcClientId: c.oidcClientId,
    samlEntityId: c.samlEntityId, samlIdpEntityId: c.samlIdpEntityId, samlIdpSsoUrl: c.samlIdpSsoUrl,
    allowedEmailDomains: c.allowedEmailDomains, allowUnverifiedEmail: c.allowUnverifiedEmail, groupRoleMap: c.groupRoleMap,
    jitProvisioning: c.jitProvisioning, jitDefaultRole: c.jitDefaultRole, trustIdpMfa: c.trustIdpMfa,
    passwordLoginDisabled: c.passwordLoginDisabled,
  }
}
