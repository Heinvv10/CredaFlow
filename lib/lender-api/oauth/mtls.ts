/**
 * Mutual TLS for OAuth clients, app side. TLS is terminated at the ingress /
 * reverse proxy, which verifies the client certificate against the lender's CA
 * and forwards the result in headers (docs/SSO-AND-OAUTH.md). This module believes those headers ONLY when the deployment
 * says the proxy is trusted (MTLS_TRUSTED_PROXY=1, off by default) and the
 * client is configured to require a certificate. Otherwise a client that
 * requires mTLS is refused: it fails closed.
 *
 * The proxy MUST overwrite or strip these headers on every request, and the app
 * port must be unreachable except through it (as for the IP allowlist,
 * lib/security/.claude.md), or any caller could assert a certificate.
 */

export type CertCheck = "ok" | "not_trusted_proxy" | "no_cert" | "dn_mismatch" | "fingerprint_mismatch"

interface MtlsClient {
  requireMtls: boolean
  mtlsSubjectDn: string | null
  mtlsCertSha256: string | null
}

const DEFAULTS = { verify: "x-ssl-client-verify", dn: "x-ssl-client-dn", fingerprint: "x-ssl-client-sha256" }

/** A DN as sorted lower-case `type=value` parts, from RFC 4514 ("CN=a,O=b") or OpenSSL ("/CN=a/O=b") form. */
export function normaliseDn(dn: string): string[] {
  const text = dn.trim()
  const slash = text.startsWith("/")
  const parts: string[] = []
  let current = ""
  for (let i = slash ? 1 : 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\\" && i + 1 < text.length) { current += text[++i]; continue }
    if (ch === (slash ? "/" : ",")) { parts.push(current); current = ""; continue }
    current += ch
  }
  parts.push(current)
  return parts
    .map((part) => {
      const eq = part.indexOf("=")
      return eq < 0 ? part.trim().toLowerCase() : `${part.slice(0, eq).trim().toLowerCase()}=${part.slice(eq + 1).trim().toLowerCase()}`
    })
    .filter((part) => part !== "")
    .sort()
}

export function checkClientCertificate(headers: Headers, client: MtlsClient, env: Readonly<Record<string, string | undefined>> = process.env): CertCheck {
  if (!client.requireMtls) return "ok"
  if (env.MTLS_TRUSTED_PROXY !== "1") return "not_trusted_proxy"
  const name = (custom: string | undefined, fallback: string) => (custom?.trim() || fallback).toLowerCase()
  if (headers.get(name(env.MTLS_VERIFY_HEADER, DEFAULTS.verify))?.trim().toUpperCase() !== "SUCCESS") return "no_cert"

  if (client.mtlsSubjectDn === null && client.mtlsCertSha256 === null) return "dn_mismatch"
  if (client.mtlsSubjectDn !== null) {
    const presented = headers.get(name(env.MTLS_DN_HEADER, DEFAULTS.dn))
    const want = normaliseDn(client.mtlsSubjectDn)
    const have = presented ? normaliseDn(presented) : []
    if (want.length === 0 || want.length !== have.length || want.some((part, i) => part !== have[i])) return "dn_mismatch"
  }
  if (client.mtlsCertSha256 !== null) {
    const presented = headers.get(name(env.MTLS_FINGERPRINT_HEADER, DEFAULTS.fingerprint))?.trim().toLowerCase().replace(/:/g, "")
    if (presented !== client.mtlsCertSha256.toLowerCase()) return "fingerprint_mismatch"
  }
  return "ok"
}
