import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { prisma } from "./prisma"
import bcrypt from "bcryptjs"
import { checkRateLimit, callerIp } from "./rate-limit"
import { authBaseConfig, roleRefusedOnThisHost, type AppRole } from "./auth-config"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { getTenantFromRequest } from "@/lib/tenant"
import { clientCredentialStamp, revalidateClientPrincipal } from "./client-session"
import { claimTotpCounter } from "./totp-claim"
import { signInTotpOutcome } from "./auth-totp-step"
import { dealerAppHost, normaliseHost, operatorAppHost } from "@/lib/config/deployment-urls"
import { isOperatorRole } from "@/lib/operator/roles"
import { authorizeOperator } from "@/lib/operator/sign-in"
import { authorizeDealer } from "@/lib/dealer/sign-in"
import { dealerTokenAtSignIn, refreshDealerToken } from "@/lib/dealer/session-token"
import { audienceOf, enrolmentRequired, principalRefusal, revalidatePrincipal } from "./auth-principal"
import { checkStaffSignIn, staffSessionAllowed } from "@/lib/security/staff-access-enforcement"
import { staffAccessSignInCode, type StaffAccessRefusal } from "@/lib/security/staff-access-messages"
import { isPortalEnabled } from "@/lib/portal/portal-policy"
import { authorizeSsoCredentials } from "@/lib/sso/provider"
import { PASSWORD_POLICY_SELECT, auditBreakGlassSignIn, passwordLoginOff } from "@/lib/sso/password-policy"

export { claimTotpCounter }

class TotpRequiredError extends CredentialsSignin {
  code = "totp_required"
}

class TotpInvalidError extends CredentialsSignin {
  code = "totp_invalid"
}

class RateLimitedError extends CredentialsSignin {
  code = "rate_limited"
}

class WrongAudienceError extends CredentialsSignin {
  code = "wrong_audience"
}

/** The lender's staff working hours or IP allowlist refused this sign-in. */
class StaffAccessRefusedError extends CredentialsSignin {
  constructor(reason: StaffAccessRefusal) {
    super()
    this.code = staffAccessSignInCode(reason)
  }
}

class PortalDisabledError extends CredentialsSignin {
  code = "portal_disabled"
}

/** The lender turned password sign-in off (SSO); only a Super Admin with a TOTP code may still use it (lib/sso/password-policy.ts). */
class PasswordLoginDisabledError extends CredentialsSignin {
  code = "password_login_disabled"
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000
// Three independent buckets — any one tripping blocks the attempt.
// Per-email catches password spray from many IPs; per-IP catches credential
// stuffing from one IP against many accounts; combined is the finest grain.
const PER_EMAIL_LIMIT = { limit: 10, windowMs: LOGIN_WINDOW_MS } as const
const PER_IP_LIMIT    = { limit: 30, windowMs: LOGIN_WINDOW_MS } as const
const COMBINED_LIMIT  = { limit: 10, windowMs: LOGIN_WINDOW_MS } as const

// Burned by `equalizeAuthTiming` when no user/client row is found, so the
// response time matches the existing-row branch and doesn't leak whether the
// email is registered. Generated once at module load against the empty string;
// `bcrypt.compare(candidate, this)` will never accept a real password.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync("", 12)

async function equalizeAuthTiming(candidate: string): Promise<void> {
  // Result is intentionally discarded — only the constant-time bcrypt work
  // matters here.
  await bcrypt.compare(candidate, DUMMY_BCRYPT_HASH)
}

// One rule set for sign-in and every request's revalidation (lib/auth-principal.ts).
export { revalidatePrincipal }

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authBaseConfig,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        code: { label: "TOTP code", type: "text" },
        // "staff" (workspace), "client" (portal), "operator" (the operator
        // console host) or "dealer" (the dealer portal host). Determines which
        // principals may authenticate — there is no fallback across audiences.
        loginType: { label: "Login type", type: "text" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        const loginType =
          credentials.loginType === "client" ? "client"
            : credentials.loginType === "operator" ? "operator"
              : credentials.loginType === "dealer" ? "dealer" : "staff"
        const email = String(credentials.email).toLowerCase().trim()
        // NextAuth v5 always passes a real Request in App Router; the cast is safe.
        const ip = callerIp(request as Request)
        const userAgent = (request as Request).headers.get("user-agent")

        const recordFailure = (reason: string) =>
          prisma.failedLoginAttempt
            .create({ data: { email, ip, userAgent, reason } })
            .catch((err: unknown) => { console.error("[auth] failedLoginAttempt insert failed:", err) })

        // Three-bucket rate gate — any one tripping blocks the attempt.
        // All three are evaluated so each records the attempt in its own bucket;
        // this ensures that a later identical request counts against all limits.
        // Buckets are intentionally NOT scoped by loginType: a client probing
        // the staff form (or vice versa) burns the same budget as a legitimate
        // attempt at their real surface. This is deliberate — cross-audience
        // probing should be rate-limited as aggressively as same-audience
        // brute-force.
        const emailGate    = checkRateLimit(`login:email:${email}`, PER_EMAIL_LIMIT)
        const ipGate       = checkRateLimit(`login:ip:${ip}`,       PER_IP_LIMIT)
        const combinedGate = checkRateLimit(`login:${email}:${ip}`, COMBINED_LIMIT)
        if (!emailGate.allowed || !ipGate.allowed || !combinedGate.allowed) {
          await recordFailure("rate_limited")
          throw new RateLimitedError()
        }

        // The host serves one audience (APP_MODE, as proxy.ts reads it): a
        // staff sign-in is refused on the client host and a portal sign-in on
        // the staff host, so a session never exists on a host that 404s its
        // pages. Same response as an unknown email.
        //
        // The operator console host (OPERATOR_APP_HOST) takes operator sign-ins
        // only, and no other host takes one (lib/proxy/operator-host.ts); the
        // same for the dealer host and dealer sign-ins (lib/proxy/dealer-host.ts).
        const hostMode = process.env.APP_MODE
        const requestHost = normaliseHost((request as Request).headers.get("host") ?? "")
        const consoleHost = operatorAppHost()
        const onConsoleHost = consoleHost !== null && requestHost === consoleHost
        const portalHost = dealerAppHost()
        const onDealerHost = portalHost !== null && requestHost === portalHost
        if (
          (hostMode === "client" && loginType !== "client") ||
          (hostMode === "staff" && loginType === "client") ||
          onConsoleHost !== (loginType === "operator") ||
          onDealerHost !== (loginType === "dealer")
        ) {
          await equalizeAuthTiming(String(credentials.password))
          await recordFailure("wrong_audience")
          throw new WrongAudienceError()
        }

        if (loginType === "operator") {
          const result = await authorizeOperator({
            email, password: String(credentials.password), code: credentials.code,
            recordFailure, equalizeTiming: equalizeAuthTiming,
          })
          if (result.ok) return result.user
          if (result.error === "wrong_audience") throw new WrongAudienceError()
          if (result.error === "totp_required") throw new TotpRequiredError()
          if (result.error === "totp_invalid") throw new TotpInvalidError()
          return null
        }

        if (loginType === "dealer") {
          const result = await authorizeDealer({
            email, password: String(credentials.password), code: credentials.code, request: request as Request,
            recordFailure, equalizeTiming: equalizeAuthTiming,
          })
          return result.ok ? result.user : null
        }

        // Staff audience — look up in User table only. Client emails get a
        // generic "wrong audience" rejection routed to the same UX as a wrong
        // password (the form already maps this to "Invalid email or password"
        // to avoid leaking which audience an email belongs to).
        const user =
          loginType === "staff"
            ? await prisma.user.findUnique({ where: { email }, include: { tenant: { select: { status: true, ssoConnection: PASSWORD_POLICY_SELECT } } } })
            : null

        if (loginType === "staff" && !user) {
          await equalizeAuthTiming(String(credentials.password))
          await recordFailure("wrong_audience")
          throw new WrongAudienceError()
        }

        if (user) {
          // Always run bcrypt regardless of active status to prevent a timing oracle
          // distinguishing active from inactive staff accounts.
          const passwordMatch = await bcrypt.compare(String(credentials.password), user.password)
          // The same rules revalidatePrincipal applies on every request
          // (inactive, binding, a suspended lender).
          const refusal = principalRefusal(user, "staff")
          if (refusal || !passwordMatch || !user.tenantId) {
            const attempts: Array<Promise<unknown>> = [
              recordFailure(
                !user.tenantId
                  ? "tenant_unassigned"
                  : passwordMatch && refusal && refusal !== "inactive" ? refusal : "wrong_password",
              ),
            ]
            if (user.active && user.tenantId) {
              attempts.push(
                prisma.loginLog.create({ data: { tenantId: user.tenantId, userId: user.id, ip, userAgent, success: false } })
                  .catch((err: unknown) => { console.error("[auth] loginLog insert failed:", err) }),
              )
            }
            await Promise.all(attempts)
            return null
          }
          const loginTenantId = user.tenantId
          // Password sign-in switched off for this lender: refuse before the code step, except
          // a Super Admin, who must then present a TOTP code (break-glass, checked below).
          const passwordOff = passwordLoginOff(user)
          if (passwordOff && user.role !== "SUPER_ADMIN") {
            await recordFailure("password_login_disabled")
            throw new PasswordLoginDisabledError()
          }

          // Enforce TOTP if the flag or the secret is set (fail-closed on inconsistent state).
          // totpVerified records that THIS sign-in checked a code: enrolling TOTP
          // later in the same session does not set it (identity writes need it).
          const totp = await signInTotpOutcome(user, credentials.code)
          if (totp.kind === "misconfigured") {
            // totpEnabled but no secret — inconsistent DB state, deny login
            await recordFailure("totp_misconfigured")
            throw new TotpInvalidError()
          }
          if (totp.kind === "required") throw new TotpRequiredError()
          if (totp.kind === "invalid") {
            await Promise.all([
              prisma.loginLog.create({ data: { tenantId: loginTenantId, userId: user.id, ip, userAgent, success: false } })
                .catch((err: unknown) => { console.error("[auth] loginLog insert failed:", err) }),
              recordFailure("totp_invalid"),
            ])
            throw new TotpInvalidError()
          }
          if (totp.kind === "replayed") {
            await recordFailure("totp_replay")
            throw new TotpInvalidError()
          }
          const totpVerified = totp.kind === "verified"
          if (passwordOff) {
            if (!totpVerified) {
              await recordFailure("password_login_disabled")
              throw new PasswordLoginDisabledError()
            }
            await auditBreakGlassSignIn({ id: user.id, email: user.email, tenantId: loginTenantId }, ip)
          }
          // The lender requires 2FA and this user has none: the session may
          // reach only the enrolment page (proxy.ts, lib/auth-guards.ts).
          const totpEnrolmentRequired = totp.kind === "not_enrolled" ? await enrolmentRequired(user, "staff") : false

          // Working hours and IP allowlist, checked once both factors passed.
          const access = await checkStaffSignIn({
            tenantId: loginTenantId, userId: user.id, email: user.email, role: user.role, ip, userAgent,
          })
          if (!access.allowed) throw new StaffAccessRefusedError(access.reason)

          // Update last login + log the sign-in
          const now = new Date()
          await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } })
            .catch((err: unknown) => { console.error("[auth] lastLoginAt update failed:", err) })
          await prisma.loginLog.create({ data: { tenantId: loginTenantId, userId: user.id, ip, userAgent, success: true } })
            .catch((err: unknown) => { console.error("[auth] loginLog insert failed:", err) })
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            tenantId: user.tenantId,
            tokenVersion: user.tokenVersion,
            totpVerified,
            totpEnrolmentRequired,
          }
        }

        // Client portal audience — look up in Client table only.
        if (loginType !== "client") {
          // Unreachable given the guard above, but explicit for type narrowing.
          throw new WrongAudienceError()
        }

        // The lambda must `await` the query so the AsyncLocalStorage frame
        // set by `withoutTenantScope` is still active when Prisma's lazy
        // `PrismaPromise` actually executes. A bare `() => prisma.x.findUnique(...)`
        // returns a lazy thenable whose execution happens after `run()` exits,
        // by which point the admin frame is gone and the tenant-scope extension
        // throws `missing-context`.
        //
        // Borrowers are per lender (Client is unique on tenantId + email), so
        // the portal host's tenant names whose client this is. A host that
        // resolves no tenant has no clients.
        const portalTenant = await getTenantFromRequest(request as Request)
        const client = portalTenant
          ? await withoutTenantScope(async () => {
              return await prisma.client.findUnique({
                where: { tenantId_email: { tenantId: portalTenant.id, email } },
              })
            })
          : null

        if (!client || !client.portalPassword) {
          // Symmetric timing equalization with the staff path so a staff email
          // submitted at /portal/login returns in the same window as a real
          // (but wrong-password) portal attempt and doesn't leak whether the
          // email is in the Client table.
          await equalizeAuthTiming(String(credentials.password))
          await recordFailure(client ? "portal_password_unset" : "wrong_audience")
          throw new WrongAudienceError()
        }

        const clientPasswordMatch = await bcrypt.compare(
          String(credentials.password),
          client.portalPassword
        )

        if (!clientPasswordMatch) {
          await recordFailure("wrong_password")
          return null
        }
        if (!(await isPortalEnabled(client.tenantId))) {
          await recordFailure("portal_disabled")
          throw new PortalDisabledError()
        }

        return {
          id: client.id,
          email: client.email,
          name: `${client.firstName} ${client.lastName}`,
          role: "CLIENT" as const,
          tenantId: client.tenantId,
          credentialStamp: clientCredentialStamp(client.id, client.tenantId, client.portalPassword),
        }
      },
    }),
    // Single sign-on: trades the ticket cookie the SSO callback set (lib/sso).
    Credentials({
      id: "sso",
      name: "sso",
      credentials: { code: { label: "TOTP code", type: "text" } },
      authorize: (credentials, request) => authorizeSsoCredentials(credentials, request as Request),
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (roleRefusedOnThisHost(user ? user.role : token.role)) return null
      // Sign-in: copy claims from the User shape returned by authorize() into the JWT.
      if (user) {
        if (!user.id) return null  // should not happen with credentials auth
        // A dealer user holds a tenant and a dealer (lib/dealer/sign-in.ts).
        if (user.role === "DEALER") return dealerTokenAtSignIn(token, user)
        // Operator staff hold an operator and no tenant; everyone else a tenant.
        const operator = isOperatorRole(user.role)
        const binding = operator ? user.operatorId : user.tenantId
        if (typeof binding !== "string" || binding.trim() === "") {
          return null
        }
        token.id = user.id
        token.role = user.role
        token.tokenVersion = user.tokenVersion ?? 0
        token.tenantId = operator ? null : user.tenantId
        if (operator) token.operatorId = user.operatorId
        token.totpVerified = user.totpVerified === true
        if (user.credentialStamp) token.credentialStamp = user.credentialStamp
        token.totpEnrolmentRequired = user.totpEnrolmentRequired === true
        if (typeof user.ssoSessionExp === "number") token.ssoExp = user.ssoSessionExp
        return token
      }

      // CLIENT sessions are revalidated against the Client table by credential
      // stamp (lib/client-session.ts); staff (any other role) against the User
      // table by tokenVersion.
      const tokenId = token.id
      // An SSO session has an absolute life: past it the user signs in at the provider again (also catches deprovisioning there).
      if (typeof token.ssoExp === "number" && Date.now() / 1000 > token.ssoExp) return null
      // DEALER first: the staff branch below would find no User row and sign
      // the dealer out (lib/dealer/session-token.ts).
      if (token.role === "DEALER") return refreshDealerToken(token)
      if (typeof tokenId === "string" && token.role === "CLIENT") {
        if (typeof token.tenantId !== "string") return null
        const fresh = await revalidateClientPrincipal(tokenId, token.tenantId, token.credentialStamp)
        // Same as staff: a transient failure retains the (tenant-bound) token.
        if (fresh === null) return null   // client gone, portal access off, or credential changed
      }
      if (typeof tokenId === "string" && token.role && token.role !== "CLIENT") {
        // Minted before the enrolment claim existed: unknown, so not trusted.
        if (typeof token.totpEnrolmentRequired !== "boolean") return null
        const tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : 0
        // The audience the token was minted for; the row must still fit it
        // (a lender user's token is never re-checked as an operator's).
        const audience = audienceOf(token.role)
        const freshPrincipal = await revalidatePrincipal(tokenId, tokenVersion, {
          audience, totpVerified: token.totpVerified === true, totpEnrolmentRequired: token.totpEnrolmentRequired,
        })
        if (freshPrincipal === "error") {
          // A transient failure may retain an already bound token, but must
          // never revive a legacy/null-tenant staff JWT.
          const bound = audience === "operator" ? token.operatorId : token.tenantId
          return typeof bound === "string" ? token : null
        }
        if (freshPrincipal === null) return null       // refused, deactivated or version bump — force sign-out
        if (audience === "staff") {
          // Working hours and IP allowlist (#82), on the policy columns the
          // same query read. Operator staff have no lender access policy.
          const allowed = await staffSessionAllowed({
            tenantId: freshPrincipal.tenantId as string, userId: tokenId, role: freshPrincipal.role,
            email: typeof token.email === "string" ? token.email : null,
          }, freshPrincipal.accessPolicy)
          if (!allowed) return null                    // outside hours / off the allowlist: ends it like a revocation
        }
        token.role = freshPrincipal.role as AppRole    // picks up role changes mid-session
        token.tenantId = freshPrincipal.tenantId
        token.totpEnrolmentRequired = freshPrincipal.totpEnrolmentRequired
        if (audience === "operator") {
          token.operatorId = freshPrincipal.operatorId
          return token
        }
      }

      if (token.role && typeof token.tenantId !== "string") return null
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as AppRole
        session.user.tenantId =
          typeof token.tenantId === "string" ? token.tenantId : null
        session.user.totpVerified = token.totpVerified === true
        session.user.totpEnrolmentRequired = token.totpEnrolmentRequired === true
        // Staff-user writes re-check it on the caller's locked row
        // (refuseLockedStaffUserWrite in lib/auth-guards.ts).
        session.user.tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : undefined
        session.user.operatorId = typeof token.operatorId === "string" ? token.operatorId : null
        session.user.dealerId = typeof token.dealerId === "string" ? token.dealerId : null
        session.user.dealerRole = token.dealerRole === "DEALER_ADMIN" || token.dealerRole === "DEALER_SALES" ? token.dealerRole : null
      }
      return session
    },
  },
})

export type { AppRole }
