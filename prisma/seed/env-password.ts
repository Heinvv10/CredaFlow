import { passwordPolicyError } from "../../lib/security/password-policy"

/**
 * A SEED_*_PASSWORD value, held to the product's password policy: a seeded
 * account is signed into like any other, so a password the product would
 * refuse at activation or reset is refused here too. Unset is undefined (the
 * seed then generates one).
 */
export function seedEnvPassword(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[name] || undefined
  if (value === undefined) return undefined
  const weak = passwordPolicyError(value)
  if (weak) throw new Error(`${name} does not meet the password policy: ${weak}`)
  return value
}
