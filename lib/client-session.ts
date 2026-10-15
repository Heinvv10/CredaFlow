import { createHmac, timingSafeEqual } from "node:crypto"
import { prisma } from "./prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"

/**
 * Client (portal) sessions have no tokenVersion: the Client table carries
 * neither a version nor a passwordChangedAt. The credential itself stands in
 * for one. At sign-in the JWT is stamped with an HMAC of the stored bcrypt
 * hash, and every refresh recomputes it — a portal password reset, a password
 * change or staff clearing the password changes the hash, so the old stamp no
 * longer matches and the session ends.
 *
 * The stamp also names the client and tenant, so a token for one client cannot
 * be satisfied by another client who happens to share the same hash.
 *
 * Keyed with AUTH_SECRET so the token never carries a bare hash-derived value:
 * the cookie is signed and encrypted, but a value that is a plain digest of the
 * hash would still help anyone who got hold of the hash.
 */
export function clientCredentialStamp(clientId: string, tenantId: string, portalPassword: string): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is required to stamp a client session")
  return createHmac("sha256", secret)
    .update(`portal-credential:${clientId}:${tenantId}:${portalPassword}`)
    .digest("hex")
    .slice(0, 32)
}

function stampsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Revalidate a client token against the DB.
 * Returns null    → force sign-out: the Client row is gone (or belongs to
 *                   another tenant), portal access is switched off
 *                   (portalPassword cleared, or the lender's featurePortal
 *                   off), or the credential has changed
 *                   since this session was issued. A token without a stamp
 *                   predates the stamp and cannot prove its credential, so it
 *                   is refused too.
 * Returns "error" → transient DB failure; caller should retain the existing
 *                   token (same behaviour as revalidatePrincipal).
 * Returns "valid" otherwise.
 *
 * Client has no deletedAt column, so there is no soft-delete state to check.
 */
export async function revalidateClientPrincipal(
  clientId: string,
  tenantId: string,
  stamp: unknown,
): Promise<"valid" | null | "error"> {
  if (typeof stamp !== "string" || stamp === "") return null

  let fresh: { portalPassword: string | null; tenant?: { config: { featurePortal: boolean } | null } | null } | null
  try {
    // The await keeps the AsyncLocalStorage frame alive until Prisma's lazy
    // query runs (see authorize()); the lookup is pinned to the token's tenant
    // explicitly instead.
    fresh = await withoutTenantScope(async () => {
      return await prisma.client.findFirst({
        where: { id: clientId, tenantId },
        select: { portalPassword: true, tenant: { select: { config: { select: { featurePortal: true } } } } },
      })
    })
  } catch (err) {
    console.error("[auth] revalidateClientPrincipal DB error — retaining existing token:", err)
    return "error"
  }

  if (!fresh || !fresh.portalPassword) return null
  // The lender switched its portal off (TenantConfig.featurePortal): every
  // client session ends. No config row means the default, on.
  if (fresh.tenant?.config?.featurePortal === false) return null
  return stampsMatch(clientCredentialStamp(clientId, tenantId, fresh.portalPassword), stamp) ? "valid" : null
}
