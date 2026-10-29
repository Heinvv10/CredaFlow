/**
 * Test-only: a minimal OpenID Connect provider on loopback (discovery, JWKS,
 * token and userinfo endpoints) so the real flow runs end to end. The test plays
 * the browser. Every claim of the ID token can be bent to exercise a refusal.
 */
import { createHash, randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose"

export interface IssueOptions {
  nonce: string
  codeChallenge: string
  redirectUri: string
  claims?: Record<string, unknown>
  /** Overrides for registered claims (iss, aud, exp, ...) or signing. */
  issuer?: string
  audience?: string
  expiresInSeconds?: number
  nonceClaim?: string
  signWithOtherKey?: boolean
  /** Sign HS256 with the client secret (a symmetric ID token). */
  hmacSign?: boolean
  omitIdToken?: boolean
}

export interface MockIdp {
  issuer: string
  clientId: string
  clientSecret: string
  issueCode(opts: IssueOptions): Promise<string>
  userinfo: Record<string, unknown>
  close(): Promise<void>
}

export async function startMockIdp(overrideIssuerInMetadata?: string): Promise<MockIdp> {
  const clientId = "cf-test-client"
  const clientSecret = "test-secret-" + randomUUID()
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const other = await generateKeyPair("RS256")
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }
  const codes = new Map<string, IssueOptions>()
  const userinfo: Record<string, unknown> = {}
  let issuer = ""

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer)
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: overrideIssuerInMetadata ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
      })
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] })
    if (url.pathname === "/userinfo") return send(200, { sub: "user-1", ...userinfo })
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
      const issued = codes.get(form.get("code") ?? "")
      codes.delete(form.get("code") ?? "")
      if (!issued || form.get("client_secret") !== clientSecret || form.get("client_id") !== clientId || form.get("redirect_uri") !== issued.redirectUri) {
        return send(400, { error: "invalid_grant" })
      }
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url")
      if (challenge !== issued.codeChallenge) return send(400, { error: "invalid_grant", error_description: "pkce" })
      const now = Math.floor(Date.now() / 1000)
      const idToken = await new SignJWT({ nonce: issued.nonceClaim ?? issued.nonce, ...issued.claims })
        .setProtectedHeader(issued.hmacSign ? { alg: "HS256" } : { alg: "RS256", kid: "k1" })
        .setIssuer(issued.issuer ?? issuer).setAudience(issued.audience ?? clientId).setSubject("user-1")
        .setIssuedAt(now - 10).setExpirationTime(now + (issued.expiresInSeconds ?? 300))
        .sign(issued.hmacSign ? new TextEncoder().encode(clientSecret) : issued.signWithOtherKey ? other.privateKey : privateKey)
      return send(200, { access_token: "at-" + randomUUID(), token_type: "Bearer", expires_in: 300, ...(issued.omitIdToken ? {} : { id_token: idToken }) })
    }
    send(404, { error: "not_found" })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    issuer, clientId, clientSecret, userinfo,
    async issueCode(opts) { const code = randomUUID(); codes.set(code, opts); return code },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}
