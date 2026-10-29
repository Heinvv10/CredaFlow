import type { CacheItem, CacheProvider } from "@node-saml/node-saml"
import { prisma } from "@/lib/prisma"

/**
 * Short-lived single-use values in the database, so every replica agrees:
 * SAML request ids (an answer is accepted once), SAML assertion ids (a replayed
 * assertion is refused) and SSO sign-in tickets. A key is created, never
 * updated; the unique key is what makes a claim atomic. Expired rows are
 * swept as a side effect of writes.
 */

const SWEEP_ONE_IN = 50

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
}

async function sweep(now: Date): Promise<void> {
  if (Math.random() * SWEEP_ONE_IN >= 1) return
  await prisma.ssoCacheEntry.deleteMany({ where: { expiresAt: { lt: now } } })
    .catch((error: unknown) => { console.error("[sso] cache sweep failed:", error) })
}

/** Writes `key` unless it is held and unexpired. True if this call took it. */
async function putIfAbsent(key: string, value: string, expiresAt: Date): Promise<boolean> {
  const now = new Date()
  await prisma.ssoCacheEntry.deleteMany({ where: { key, expiresAt: { lt: now } } })
  try {
    await prisma.ssoCacheEntry.create({ data: { key, value, expiresAt } })
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
  await sweep(now)
  return true
}

/** True for the first caller to claim `key` before `until`, false for every later one. */
export function claimOnce(key: string, until: Date): Promise<boolean> {
  return putIfAbsent(key, "1", until)
}

/** node-saml's cache, in the database and namespaced by lender. */
export class DbSamlCache implements CacheProvider {
  constructor(private readonly tenantId: string, private readonly lifeMs: number) {}

  private k(key: string): string {
    return `saml:${this.tenantId}:${key}`
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const createdAt = Date.now()
    const saved = await putIfAbsent(this.k(key), value, new Date(createdAt + this.lifeMs))
    return saved ? { value, createdAt } : null
  }

  async getAsync(key: string): Promise<string | null> {
    const row = await prisma.ssoCacheEntry.findUnique({ where: { key: this.k(key) } })
    return row && row.expiresAt.getTime() > Date.now() ? row.value : null
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null
    const value = await this.getAsync(key)
    await prisma.ssoCacheEntry.deleteMany({ where: { key: this.k(key) } })
    return value
  }

  /** Read, then delete by key; only the caller whose delete removed the row gets the value. */
  async consumeAsync(key: string): Promise<string | null> {
    const value = await this.getAsync(key)
    if (value === null) return null
    const { count } = await prisma.ssoCacheEntry.deleteMany({ where: { key: this.k(key) } })
    return count === 1 ? value : null
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    return putIfAbsent(this.k(key), value, new Date(expiresAtMs))
  }
}
