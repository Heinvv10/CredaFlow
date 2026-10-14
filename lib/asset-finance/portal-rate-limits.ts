import type { RateLimitOptions } from "@/lib/rate-limit"

// Per-client limits on the portal's asset-finance writes (lib/rate-limit.ts,
// in-memory, single replica). Keyed by tenant and client id.

/** E-signature attempts: each re-reads and re-renders the deal document. */
export const PORTAL_SIGN_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 10 * 60_000 }

/** Entity document uploads: each stores up to 10 MB. */
export const PORTAL_ENTITY_UPLOAD_RATE_LIMIT: RateLimitOptions = { limit: 20, windowMs: 10 * 60_000 }

/** Live documents one entity may hold before a portal upload is refused. */
export const PORTAL_ENTITY_DOCUMENT_CAP = 200
