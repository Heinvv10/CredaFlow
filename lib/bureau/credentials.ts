/**
 * Per-tenant bureau credentials: `TenantConfig.bureauCredentials` holds ONE
 * secret-box sealed JSON object keyed by provider id, e.g.
 *   { "xds": { "username": "...", "password": "...", "endpointUrl": "..." } }
 *
 * Same box and key as the WhatsApp and email secrets (WABA_ENC_KEY: one box,
 * one key). Unlike those columns there is no legacy plaintext to tolerate, so
 * a value without the sealed marker is refused rather than passed through.
 *
 * Experian (EXPERIAN_* env) and TransUnion (TenantConfig.transunionKey) keep
 * their existing credential sources; moving them here is platform work.
 */
import { isSealed, openSecret, sealSecret } from "@/lib/crypto/secret-box"
import type { BureauCredentials } from "./types"

const KEY_ENV = "WABA_ENC_KEY"

export class BureauCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BureauCredentialsError"
  }
}

export type BureauCredentialMap = Record<string, BureauCredentials>

function key(): string {
  const value = process.env[KEY_ENV]
  if (!value) throw new BureauCredentialsError(`${KEY_ENV} is not set; bureau credentials cannot be sealed or opened`)
  return value
}

function isCredentialMap(value: unknown): value is BureauCredentialMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((bag) =>
    typeof bag === "object" && bag !== null && !Array.isArray(bag) &&
    Object.values(bag).every((v) => typeof v === "string"),
  )
}

export function sealBureauCredentials(map: BureauCredentialMap): string {
  if (!isCredentialMap(map)) throw new BureauCredentialsError("bureau credentials must map provider ids to string fields")
  return sealSecret(JSON.stringify(map), key())
}

/** Null column = no bureau stores credentials here. Throws on anything unreadable. */
export function openBureauCredentials(stored: string | null): BureauCredentialMap {
  if (stored == null || stored === "") return {}
  if (!isSealed(stored)) throw new BureauCredentialsError("stored bureau credentials are not sealed; refusing plaintext")
  let parsed: unknown
  try {
    parsed = JSON.parse(openSecret(stored, key()))
  } catch (error) {
    if (error instanceof BureauCredentialsError) throw error
    // A wrong key, tampered ciphertext or non-JSON plaintext. The cause is not
    // chained: a JSON.parse message can quote the decrypted secret.
    throw new BureauCredentialsError("stored bureau credentials could not be opened")
  }
  if (!isCredentialMap(parsed)) throw new BureauCredentialsError("stored bureau credentials are malformed")
  return parsed
}

/** The stored map with `update` applied: a bag replaces that bureau's, null removes it. */
export function mergeBureauCredentials(
  current: BureauCredentialMap,
  update: Record<string, BureauCredentials | null>,
): BureauCredentialMap {
  const next: BureauCredentialMap = { ...current }
  for (const [id, bag] of Object.entries(update)) {
    if (bag === null) delete next[id]
    else next[id] = bag
  }
  return next
}

/**
 * A TenantConfig row as it may leave the server: the sealed bureau
 * credentials replaced by whether any are stored. Every response that returns
 * a whole TenantConfig row goes through this.
 */
export function redactBureauCredentials<C extends { bureauCredentials: string | null }>(
  config: C,
): Omit<C, "bureauCredentials"> & { bureauCredentialsConfigured: boolean } {
  const { bureauCredentials, ...rest } = config
  return { ...rest, bureauCredentialsConfigured: Boolean(bureauCredentials) }
}

export function redactTenantBureauCredentials<T extends { config: { bureauCredentials: string | null } | null }>(tenant: T) {
  return { ...tenant, config: tenant.config ? redactBureauCredentials(tenant.config) : null }
}
