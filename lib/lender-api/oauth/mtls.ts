/**
 * Mutual TLS for OAuth clients, app side. TLS is terminated at the ingress /
 * reverse proxy, which verifies the client certificate against the lender's CA
 * and forwards the result in headers (docs/SSO-AND-OAUTH.md). This module believes those headers ONLY when the deployment
 * says the proxy is trusted (MTLS_TRUSTED_PROXY=1, off by default) and the
 * client is configured to require a certificate. Otherwise a client that
 * requires mTLS is refused: it fails closed.
 *
 * A client is pinned to its certificate by SHA-256 fingerprint (required). It may
 * also pin the subject DN, compared as one exact string in the RFC 4514 form the
 * proxy emits (docs/SSO-AND-OAUTH.md); the DN is never parsed or normalised.
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

export function checkClientCertificate(headers: Headers, client: MtlsClient, env: Readonly<Record<string, string | undefined>> = process.env): CertCheck {
  if (!client.requireMtls) return "ok"
  if (env.MTLS_TRUSTED_PROXY !== "1") return "not_trusted_proxy"
  const name = (custom: string | undefined, fallback: string) => (custom?.trim() || fallback).toLowerCase()
  if (headers.get(name(env.MTLS_VERIFY_HEADER, DEFAULTS.verify))?.trim().toUpperCase() !== "SUCCESS") return "no_cert"

  // The fingerprint is the pin: a client that requires mTLS without one never passes.
  const presentedFp = headers.get(name(env.MTLS_FINGERPRINT_HEADER, DEFAULTS.fingerprint))?.trim().toLowerCase().replace(/:/g, "")
  if (client.mtlsCertSha256 === null || presentedFp !== client.mtlsCertSha256.toLowerCase()) return "fingerprint_mismatch"
  // An optional extra pin on the subject: the proxy's RFC 4514 string, byte for byte. No parsing,
  // so there is nothing for a differently written DN (reordered, slash form, '+' multi-valued
  // RDNs, other case) to slip through.
  if (client.mtlsSubjectDn !== null && headers.get(name(env.MTLS_DN_HEADER, DEFAULTS.dn)) !== client.mtlsSubjectDn) return "dn_mismatch"
  return "ok"
}
