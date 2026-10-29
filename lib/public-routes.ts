export function isPublicOperationalRoute(pathname: string) {
  if (pathname === "/api/health") return true
  // Kubernetes probes (deploy/helm): no session, no secret, a bare status.
  if (pathname === "/api/health/live" || pathname === "/api/health/ready") return true
  // Prometheus scrape: the handler is off without METRICS_TOKEN and bearer-only with it.
  if (pathname === "/api/metrics") return true
  // Cron routes authenticate via x-cron-secret in their handler (lib/cron-auth.ts).
  // They bypass NextAuth's session gate so the in-app scheduler (instrumentation.ts)
  // and any external scheduler can reach them.
  if (pathname.startsWith("/api/cron/")) return true
  // Inbound provider webhooks authenticate via HMAC signature verification
  // inside the handler (lib/webhooks/verify.ts). They MUST bypass NextAuth's
  // session gate because the providers (WhatsApp BSPs, Twilio, BulkSMS, Meta
  // WABA) post without cookies.
  // CONTRACT: every route under /api/webhooks/* MUST verify a provider-issued
  // HMAC signature in its handler before doing any work. There is no automated
  // enforcement of this — adding a route under this prefix and skipping HMAC
  // verification is a security bug.
  if (pathname.startsWith("/api/webhooks/")) return true
  // RFC 8058 List-Unsubscribe one-click endpoint — hit by the recipient's
  // MUA / mailbox provider with no session. Authenticates via HMAC-signed
  // token (lib/unsubscribe/token.ts). Accept the trailing-slash variant
  // because some MUAs canonicalise URLs that way before POSTing.
  if (
    pathname === "/api/messaging/unsubscribe" ||
    pathname === "/api/messaging/unsubscribe/"
  ) {
    return true
  }
  // One-time PASQ acknowledgement links (NCA s.92(1)). Origination is
  // telephonic and online, so the consumer usually has no portal account and
  // therefore no session — these two routes authenticate on the high-entropy
  // secret in the path itself (lib/compliance/pasq-link-token.server.ts), which
  // is single-active, single-use and 48h-lived.
  // CONTRACT: every route under /api/pasq-link/* MUST resolve the token through
  // `resolvePasqLinkToken` before doing any work, and MUST NOT accept an
  // application id from the request — the token names the application.
  if (pathname.startsWith("/api/pasq-link/")) return true
  // One-time KYC selfie capture links. Same rationale as the PASQ links above:
  // origination is telephonic and online, so the consumer usually has no portal
  // account and therefore no session — this route authenticates on the
  // high-entropy secret in the path itself
  // (lib/kyc/selfie-link-token.server.ts), which is single-active, single-use
  // and 24h-lived.
  // CONTRACT: every route under /api/selfie-link/* MUST resolve the token
  // through `resolveSelfieLinkToken` before doing any work, and MUST NOT accept
  // a tenant, application or client id from the request — the token names them.
  if (pathname.startsWith("/api/selfie-link/")) return true
  return false
}
