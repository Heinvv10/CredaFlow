/**
 * Cookie-jar HTTP client for driving the sim app as one actor (a staff user or
 * a portal client). One SimClient = one browser: its cookies are its session.
 *
 * Login is the real Auth.js credentials flow that components/auth/LoginForm
 * runs through next-auth/react `signIn("credentials", { redirect: false })`:
 * GET /api/auth/providers, GET /api/auth/csrf (sets the csrf cookie), POST
 * /api/auth/callback/credentials as a form with X-Auth-Return-Redirect: 1,
 * then GET /api/auth/session. `authorize()` in lib/auth.ts does the checking.
 *
 * Staff send the TOTP code with the password in one POST. The form's first
 * POST (no code → "totp_required") is skipped: it is the same authorize()
 * path and would burn a slot of the 10-per-15-minute per-email login limit.
 * The code is generated for the APP's clock (/api/health), not this host's.
 */
import { generateTotpCode } from "../../../lib/totp"
import { appNow } from "./clock"
import { simBaseUrl } from "./env"

export interface ApiResponse<T = unknown> {
  status: number
  headers: Headers
  /** Parsed body when the response is JSON, else null. */
  json: T | null
  text: string
  bytes: Uint8Array
}

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 2000)}`)
    this.name = "ApiError"
  }
}

export interface RequestOptions {
  /** Statuses that count as success; anything else throws ApiError. */
  expect?: readonly number[]
  headers?: Record<string, string>
}

export interface SessionUser {
  id: string
  email: string
  name: string | null
  role: string
  tenantId?: string | null
  totpVerified?: boolean
}

/** A string is sent as-is (the caller sets its content-type); objects and arrays as JSON. */
type Body = FormData | URLSearchParams | string | Record<string, unknown> | unknown[] | undefined

export class SimClient {
  private readonly cookies = new Map<string, string>()
  user: SessionUser | null = null

  constructor(readonly baseUrl: string = simBaseUrl()) {}

  async request<T = unknown>(method: string, path: string, body?: Body, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers }
    let payload: FormData | URLSearchParams | string | undefined
    if (body instanceof FormData || body instanceof URLSearchParams || typeof body === "string") {
      payload = body
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers["content-type"] = "application/json"
    }
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload, redirect: "manual", cache: "no-store" })
    this.storeCookies(res.headers)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json")
    const json = isJson && text ? (JSON.parse(text) as T) : null

    const expected = opts.expect ?? (method === "POST" ? [200, 201] : [200])
    if (!expected.includes(res.status)) throw new ApiError(method, path, res.status, text)
    return { status: res.status, headers: res.headers, json, text, bytes }
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, undefined, opts)
  }

  post<T = unknown>(path: string, body?: Body, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, body, opts)
  }

  put<T = unknown>(path: string, body?: Body, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", path, body, opts)
  }

  patch<T = unknown>(path: string, body?: Body, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("PATCH", path, body, opts)
  }

  /** Staff workspace login: password plus a TOTP code from `totpSecret`. */
  async loginStaff(email: string, password: string, totpSecret: string): Promise<SessionUser> {
    const code = generateTotpCode(totpSecret, (await appNow(this.baseUrl)).getTime())
    const user = await this.credentialsSignIn({ email, password, code, loginType: "staff" })
    if (user.role === "CLIENT" || user.totpVerified !== true) {
      throw new Error(`loginStaff(${email}): session is not a TOTP-verified staff session (role ${user.role})`)
    }
    return user
  }

  /**
   * First sign-in of a staff user who has not enrolled TOTP yet (password
   * only; lib/auth.ts skips the code check until a secret is stored). The
   * session is not TOTP-verified: use it only to enrol, then loginStaff().
   */
  async loginStaffForEnrolment(email: string, password: string): Promise<SessionUser> {
    const user = await this.credentialsSignIn({ email, password, loginType: "staff" })
    if (user.role === "CLIENT") throw new Error(`loginStaffForEnrolment(${email}): session role is CLIENT`)
    return user
  }

  /** Client portal login (Client.portalPassword; no TOTP for clients). */
  async loginClient(email: string, password: string): Promise<SessionUser> {
    const user = await this.credentialsSignIn({ email, password, loginType: "client" })
    if (user.role !== "CLIENT") {
      throw new Error(`loginClient(${email}): session role is ${user.role}, not CLIENT`)
    }
    return user
  }

  /** The current Auth.js session, or null when signed out or expired. */
  async session(): Promise<SessionUser | null> {
    const res = await this.get<{ user?: SessionUser } | null>("/api/auth/session")
    return res.json?.user ?? null
  }

  private async credentialsSignIn(fields: Record<string, string>): Promise<SessionUser> {
    this.cookies.clear()
    this.user = null
    const providers = await this.get<Record<string, { type: string }>>("/api/auth/providers")
    if (providers.json?.credentials?.type !== "credentials") {
      throw new Error(`no credentials provider at ${this.baseUrl}/api/auth/providers`)
    }
    const csrf = await this.get<{ csrfToken: string }>("/api/auth/csrf")
    const csrfToken = csrf.json?.csrfToken
    if (!csrfToken) throw new Error("GET /api/auth/csrf returned no csrfToken")

    const res = await this.post<{ url?: string }>(
      "/api/auth/callback/credentials",
      new URLSearchParams({ ...fields, csrfToken, callbackUrl: this.baseUrl }),
      { headers: { "X-Auth-Return-Redirect": "1" }, expect: [200, 401] },
    )
    const url = new URL(res.json?.url ?? `${this.baseUrl}/?error=no_redirect_url`)
    const error = url.searchParams.get("error")
    if (error || res.status !== 200) {
      // `code` is the CredentialsSignin subclass code from lib/auth.ts
      // (totp_required, totp_invalid, rate_limited, wrong_audience).
      const code = url.searchParams.get("code") ?? "none"
      throw new Error(`sign-in as ${fields.email} refused: ${error ?? res.status} (code ${code})`)
    }

    const user = await this.session()
    if (!user) throw new Error(`sign-in as ${fields.email} returned no session`)
    this.user = user
    return user
  }

  private storeCookies(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";")
      const eq = pair.indexOf("=")
      if (eq < 1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // Expiry is judged by the server's (faked) clock, so only explicit
      // deletions are honoured here: an Expires date that is in the real
      // past may be weeks in the simulated future.
      const deleted =
        value === "" ||
        attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a) || /^\s*expires\s*=.*\b1970\b/i.test(a))
      if (deleted) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
}
