import type { NextAuthConfig } from "next-auth"
import type { UserRole } from "@prisma/client"

/** Staff roles plus the CLIENT sentinel used for portal sessions. */
export type AppRole = UserRole | "CLIENT"

declare module "next-auth" {
  interface User {
    role: AppRole
    tokenVersion?: number
    tenantId?: string | null
    /** True only when THIS sign-in verified a TOTP code (lib/auth.ts). */
    totpVerified?: boolean
    /** Keyed fingerprint of the portal credential (CLIENT only); lib/client-session.ts. */
    credentialStamp?: string
    /** Set at sign-in when the lender requires 2FA and this user has none (lib/auth.ts). */
    totpEnrolmentRequired?: boolean
  }
  interface Session {
    user: {
      id: string
      email: string
      name: string | null
      role: AppRole
      tenantId?: string | null
      totpVerified?: boolean
      /** This user must enrol TOTP before anything else (proxy.ts, lib/auth-guards.ts). */
      totpEnrolmentRequired?: boolean
      /** The User row's tokenVersion this session was issued at (staff only). */
      tokenVersion?: number
    }
  }
}

/**
 * A host serves one audience (APP_MODE, as proxy.ts reads it): the client host
 * only honours CLIENT sessions and the staff host only staff ones. Checked on
 * every decode, not just at sign-in, so it holds even when the two hosts share
 * a signing secret (docker-compose falls back to the shared AUTH_SECRET) and a
 * cookie from one is replayed against the other. Read per call, not at load.
 * A single host (APP_MODE unset or "all") honours both.
 */
export function roleRefusedOnThisHost(role: unknown): boolean {
  const mode = process.env.APP_MODE
  if (mode === "client") return role !== "CLIENT"
  if (mode === "staff") return role === "CLIENT"
  return false
}

// Prefer AUTH_URL (NextAuth v5) and fall back to NEXTAUTH_URL (v4 alias).
// Phase 2 split sets per-container AUTH_URL — relying on NEXTAUTH_URL only
// would produce unprefixed cookies on the portal container if a deploy
// ever set AUTH_URL but not NEXTAUTH_URL.
const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL
const useSecureCookies = authUrl?.startsWith("https://")

export const authBaseConfig = {
  trustHost: true,
  cookies: {
    // __Host-: the browser refuses it unless Secure, Path=/ and no Domain, so a
    // sibling lender's subdomain can neither set nor shadow the session.
    sessionToken: {
      name: useSecureCookies ? "__Host-authjs.session-token" : "authjs.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: !!useSecureCookies },
    },
    csrfToken: {
      name: useSecureCookies ? "__Host-authjs.csrf-token" : "authjs.csrf-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: !!useSecureCookies },
    },
    callbackUrl: {
      name: useSecureCookies ? "__Secure-authjs.callback-url" : "authjs.callback-url",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: !!useSecureCookies },
    },
  },
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (roleRefusedOnThisHost(user ? user.role : token.role)) return null
      if (user) {
        if (!user.id) return null
        token.id = user.id
        token.role = user.role
        token.tokenVersion = user.tokenVersion ?? 0
        token.tenantId = user.tenantId ?? null
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as AppRole
        session.user.tenantId =
          typeof token.tenantId === "string" ? token.tenantId : null
        // proxy.ts reads this from the cookie, so the edge session must carry it.
        // Absent stays undefined (not false): a token minted before the claim
        // existed is held at the proxy, not waved through.
        session.user.totpEnrolmentRequired =
          typeof token.totpEnrolmentRequired === "boolean" ? token.totpEnrolmentRequired : undefined
      }
      return session
    },
  },
} satisfies NextAuthConfig
