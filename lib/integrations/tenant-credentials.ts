/**
 * Per-tenant provider credentials: the only reader and writer of the secret
 * TenantConfig columns. Each lender brings its own Netcash, TransUnion,
 * Experian, SmileIdentity, BulkSMS and Stitch accounts.
 *
 * Sealed at rest with lib/crypto/secret-box.ts under WABA_ENC_KEY, the one
 * key the email and WhatsApp credentials already share (lib/email/secrets.ts).
 * WRITES FAIL CLOSED: a secret with no key configured is refused. READS ARE
 * TOLERANT of a legacy plaintext row (no `enc:v1:` marker), so values saved
 * before this change keep working until they are next saved.
 *
 * Environment fallback: Experian, SmileIdentity and Stitch were configured by
 * environment variables before they were per tenant. Those variables are
 * still honoured, but only for the tenant ENV_CREDENTIALS_TENANT_SLUG names
 * (provision-lender sets it on a dedicated stack) — never for another tenant,
 * whatever the statuses. Unset, there is no fallback at all, so one lender's
 * accounts can never serve another's borrowers.
 */
import { prisma } from "@/lib/prisma"
import { isSealed, openSecret, sealSecret } from "@/lib/crypto/secret-box"

const KEY_ENV = "WABA_ENC_KEY"

export const SEALED_CREDENTIAL_FIELDS = [
  "netcashKey",
  "netcashDebitOrderKey",
  "netcashRiskReportsKey",
  "bulkSmsKey",
  "transunionKey",
  "smileIdentityKey",
  "experianKey",
  "stitchKey",
  "stitchWebhookSecret",
] as const
export type SealedCredentialField = (typeof SEALED_CREDENTIAL_FIELDS)[number]

export function isSealedCredentialField(key: string): key is SealedCredentialField {
  return (SEALED_CREDENTIAL_FIELDS as readonly string[]).includes(key)
}

/** A credential a caller may not store: input that is already ciphertext. */
export class CredentialInputError extends Error {
  constructor() {
    super("A credential must be given as entered, not as a sealed value")
    this.name = "CredentialInputError"
  }
}

/**
 * Seals a credential for storage. Input that already looks sealed is refused,
 * never stored as-is: a caller must not plant ciphertext it did not seal here
 * (another tenant's sealed value, say, read from a backup).
 */
export function sealCredential(value: string): string {
  if (isSealed(value)) throw new CredentialInputError()
  const key = process.env[KEY_ENV]
  if (!key) throw new Error(`${KEY_ENV} must be set to store provider credentials (refusing to store a secret in plaintext)`)
  return sealSecret(value, key)
}

/** Opens a stored credential; a legacy plaintext value passes through. */
export function openCredential(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!isSealed(value)) return value
  const key = process.env[KEY_ENV]
  if (!key) throw new Error(`${KEY_ENV} is not set but a stored provider credential is encrypted`)
  return openSecret(value, key)
}

/** What a settings screen may show of a credential: whether it is set, never any of it. */
export function maskCredential(value: string | null | undefined): string {
  return value ? "********" : ""
}

/** A TenantConfig row as an API may return it: every credential column masked. */
export function maskConfigCredentials<T extends Record<string, unknown>>(config: T): T {
  const masked: Record<string, unknown> = { ...config }
  for (const key of SEALED_CREDENTIAL_FIELDS) {
    if (key in masked) masked[key] = maskCredential(masked[key] as string | null)
  }
  return masked as T
}

/** A Tenant row with its config, as an API may return it. */
export function withMaskedCredentials<T extends { config: Record<string, unknown> | null }>(tenant: T): T {
  return { ...tenant, config: tenant.config && maskConfigCredentials(tenant.config) }
}

/** Splits an "id:secret" pair at the FIRST colon, so a secret may contain colons. */
export function splitCredentialPair(value: string | null): { id: string; secret: string } | null {
  if (!value) return null
  const at = value.indexOf(":")
  if (at <= 0 || at === value.length - 1) return null
  return { id: value.slice(0, at), secret: value.slice(at + 1) }
}

export async function loadTenantCredential(tenantId: string, field: SealedCredentialField): Promise<string | null> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { [field]: true } })
  return openCredential((config as Record<string, string | null> | null)?.[field])
}

/**
 * True when `tenantId` owns the deployment's environment credentials: it is
 * the tenant ENV_CREDENTIALS_TENANT_SLUG names. A rule over the tenants'
 * statuses ("the one ACTIVE tenant") is not ownership: with the owner
 * SUSPENDED and another lender ACTIVE, that lender would get the owner's
 * accounts. Unset or naming no tenant, nobody owns them.
 */
export async function isEnvCredentialsTenant(tenantId: string): Promise<boolean> {
  const slug = process.env.ENV_CREDENTIALS_TENANT_SLUG?.trim()
  if (!slug) return false
  const owner = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } })
  return owner?.id === tenantId
}

/** The tenant's "id:secret" credential, or the env pair when the tenant owns the env credentials. */
export async function loadCredentialPair(
  tenantId: string,
  field: SealedCredentialField,
  envFallback: { id?: string; secret?: string },
): Promise<{ id: string; secret: string } | null> {
  const own = splitCredentialPair(await loadTenantCredential(tenantId, field))
  if (own) return own
  if (!envFallback.id || !envFallback.secret) return null
  return (await isEnvCredentialsTenant(tenantId)) ? { id: envFallback.id, secret: envFallback.secret } : null
}
