# Staff single sign-on, OAuth clients and mutual TLS

Operator and lender-admin runbook for `lib/sso/` and `lib/lender-api/oauth/`
(tender spec 4.5 and 3.6). Module rules for developers are in
`lib/sso/.claude.md` and `lib/lender-api/.claude.md`.

## 1. Staff single sign-on

One connection per lender (`SsoConnection`): OpenID Connect or SAML 2.0, set up
by a Super Admin in a TOTP-verified session at Settings, Single sign-on. Every
change is audited (`SSO_CONNECTION_UPDATED`); the OIDC client secret is sealed
with `SSO_SECRET_KEY` and never shown again.

Set at the identity provider:

- OIDC: redirect URI `<NEXTAUTH_URL>/api/auth/sso/oidc/callback`; the code flow
  with PKCE; scopes `openid email profile` (plus whatever carries groups).
- SAML: import `<NEXTAUTH_URL>/api/auth/sso/saml/metadata` (service provider
  metadata, served while SAML is on), or enter the assertion consumer URL
  `<NEXTAUTH_URL>/api/auth/sso/saml/acs` (HTTP-POST) and the audience = the
  service-provider entity id typed in CredaFlow. The assertion must be signed
  (SHA-256 or better) and carry a bearer `SubjectConfirmationData` with
  `Recipient` = the ACS URL and `InResponseTo` = the request CredaFlow sent.
  Sign-in always starts at CredaFlow; an unsolicited (IdP-initiated) response, or
  a response to a different request than the browser's own, is refused.
- SAML subject (who the person is for life): either the lender's immutable
  attribute (objectGUID, immutableId: type its name in "Immutable id attribute"),
  or a PERSISTENT NameID (`urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`).
  Transient, email-address and unspecified NameIDs are refused as a subject, and so
  is an empty one. This is a deliberate trade-off: a provider that can only send an
  email-address NameID cannot be used until it also sends one of the two stable ids,
  because an email can be re-assigned to someone else at the provider.

Who gets in:

- Allowed email domains are required before SSO can be switched on.
- The identity provider's email must be verified (OIDC `email_verified` true or
  "true"; a missing claim is refused unless the lender ticks "Accept emails the
  provider does not mark as verified"; SAML assertions are signed by the lender's
  provider and taken as verified), plain ASCII (an address with look-alike or
  non-ASCII characters is refused), and equal a staff user's email in THAT lender,
  once. That first sign-in binds the provider's stable subject (OIDC issuer+sub,
  SAML IdP entity id+immutable id) to the user and audits it (`SSO_IDENTITY_LINKED`).
  From then on the subject decides: a different subject presenting that email is
  refused. Changing the provider (protocol, issuer, entity id, subject attribute)
  clears the bindings; people then re-link by email at their next sign-in.
- Nothing is created unless "Create staff accounts on first sign-in" is on (off
  by default). A Super Admin or operator user is never created, mapped or changed
  by the provider (also enforced by CHECK constraints on `SsoConnection`), and a
  Super Admin cannot sign in through the provider: password plus authenticator code only.
- Group to role mapping: when a mapping is set, a user in no mapped group is
  refused (not kept at their old role); otherwise they get the highest mapped role.
  The role is applied only after every other check passed and the ticket was spent
  (audited `SSO_ROLE_SYNCED`), so a refused sign-in never changes a role.
- Every successful SSO sign-in is audited (`SSO_SIGN_IN_SUCCEEDED`), in addition to
  the login log; refusals naming a real user are audited too.

### Second factor: what SSO changes and what it does not

SSO adds a way in; it does not relax the staff TOTP rule (CLAUDE.md, "Staff TOTP 2FA").

- A user who enrolled CredaFlow TOTP is always asked for the code after the
  provider returns them. `totpVerified` (which gates identity, user, API-key and
  OAuth-client writes) therefore keeps meaning "a CredaFlow code was checked".
- A user with no CredaFlow TOTP, when the lender requires staff 2FA, is held at
  the enrolment page, whatever MFA the provider performed. What the provider
  reports (OIDC `amr` / `acr`, SAML AuthnContext, plus the lender's own "values
  that mean MFA") is recorded in the sign-in audit row as information only.

### Sessions and deprovisioning

- An SSO session has an absolute lifetime (Settings, default 10 hours, 1 to 168).
  After it the user must sign in at the provider again, which is where a person
  disabled or removed there is stopped.
- Disabling someone at the provider does NOT end an open session sooner and does
  NOT disable their CredaFlow account. Until SCIM provisioning exists, also
  deactivate them in CredaFlow (Settings, Users); that ends their sessions at once.
- Once SSO is live, turn password sign-in off ("Turn off password sign-in"), or
  staff keep a password path that bypasses the provider's lifecycle.

### Password sign-in off

"Turn off password sign-in" is allowed only while SSO is on. Then password
sign-in is refused for everyone except a SUPER_ADMIN who also gives a valid
TOTP code. That is the break-glass path: `lender:bootstrap-admin --break-glass`
(docs/DEPLOY.md) resets exactly such a user's password and TOTP. Each use is
audited (`SSO_PASSWORD_BREAK_GLASS`). Keep at least one Super Admin enrolled in
TOTP before turning passwords off.

### Environment

| Variable | Notes |
|---|---|
| `SSO_SECRET_KEY` | required to save a connection. 32 bytes base64. Seals the OIDC client secret; losing it means re-entering the secret |
| `SSO_ALLOW_PRIVATE_IDP` | `1` lets the OIDC discovery, token and JWKS requests reach a private address (an identity provider on the lender's own network). Default: public addresses only, https only. The address is checked just before each request, not pinned for the connection, so a DNS answer that changes in between is a residual risk; the issuer is typed by a TOTP-verified Super Admin, and an egress firewall on the app host closes it |
| `AUTH_SECRET` | the staff container's; sign-in tickets, flow state and OAuth access tokens are signed with keys derived from it. Rotating it signs everyone out and invalidates every issued OAuth access token at once (clients just fetch a new one) and any SSO sign-in in flight; nothing stored is lost |
| `TRUSTED_PROXY` | number of proxies in front. Needed for any source-address allowlist and for per-caller rate limits: unset, every caller is "unknown" (an allowlisted key is refused, and all callers share one bucket) |

## 2. OAuth 2.0 clients for `/api/v1`

Settings, API & webhooks, OAuth clients (Super Admin, TOTP-verified; audited
`OAUTH_CLIENT_CREATED` / `OAUTH_CLIENT_REVOKED`). A client gets `cfc_...` id and
`cfs_...` secret (shown once; only its SHA-256 is stored), the same scopes as API
keys, and a lifetime of 30 to 365 days.

    POST /api/auth/oauth/token
    Authorization: Basic base64(client_id:client_secret)     (or client_id / client_secret form fields)
    Content-Type: application/x-www-form-urlencoded

    grant_type=client_credentials&scope=loans:read

The answer is a bearer token valid 15 minutes; send it to `/api/v1/*` as
`Authorization: Bearer <token>`. API keys keep working. Both go through the same
gate: per-credential rate limit (120/minute), `ApiRequestLog` rows (an OAuth
client is recorded as `oauthClientId`), and the lender must be active. The client
is re-read on every call: revoking it, expiring it, narrowing its scopes, a
deactivated or demoted creator, or a suspended lender all take effect on the next request.

Rate limits are in memory, per application instance: with N replicas a credential
may make up to N times the limit (a shared store is a separate work item).
Per-caller buckets need `TRUSTED_PROXY`; without it every unauthenticated caller
shares one bucket.

### Source-address allowlist (API keys and OAuth clients)

Each API key and OAuth client can carry an allowlist of addresses / CIDR blocks
(Settings, API & webhooks; audited at creation). It is enforced on every `/api/v1`
call with either credential, and for OAuth clients on the token request too, using
the same caller address as the staff allowlist (the `X-Forwarded-For` hop that
`TRUSTED_PROXY` trusted proxies appended). With an allowlist set and no readable
caller address the request is refused (403 `ip_not_allowed`, 401 at the token endpoint).
As for the staff allowlist, the app port must be unreachable except through the proxy.

## 3. Mutual TLS

TLS is terminated and the client certificate verified by the ingress / reverse
proxy, never by the app. The app trusts what the proxy forwards ONLY when
`MTLS_TRUSTED_PROXY=1` (off by default) and only for OAuth clients registered
with "Require a pinned TLS client certificate". Such a client is refused when the
proxy is not trusted (it fails closed), at the token endpoint AND on every API
call, so a stolen token is useless without the certificate.

Proxy duties (nginx shown; the same for HAProxy, Envoy, an ingress). The proxy
forwards the verified certificate itself; the APP computes its SHA-256 and compares it
to the client's pin, so nothing depends on how the proxy formats a fingerprint (nginx's
`$ssl_client_fingerprint` is SHA-1):

    ssl_client_certificate /etc/ssl/lender-client-ca.pem;   # the CA the lender issues client certs from
    ssl_verify_client optional;                              # in the server block that terminates TLS

    # Included in EVERY location that proxies to the app (not only the API ones):
    #   a location with any proxy_set_header of its own does not inherit the server-level ones,
    #   and an unlisted header passes through from the caller unchanged.
    # /etc/nginx/snippets/cf-client-cert.conf
    proxy_set_header X-SSL-Client-Verify  $ssl_client_verify;          # "SUCCESS", "NONE" or "FAILED:..."
    proxy_set_header X-SSL-Client-DN      $ssl_client_s_dn;            # RFC 4514 form
    proxy_set_header X-SSL-Client-Cert    $ssl_client_escaped_cert;    # URL-encoded PEM; empty without a certificate

    location /api/ { include snippets/cf-client-cert.conf; proxy_pass http://app; }   # covers /api/v1 and /api/auth/oauth/token
    location /     { include snippets/cf-client-cert.conf; proxy_pass http://app; }

Rules that make this safe:

1. The proxy MUST set all three headers on every request to the app, in every
   location and server block, overwriting any the caller sent (an empty value when
   there is no certificate). One location that forgets lets a caller assert a certificate.
2. The app port must be unreachable except through the proxy (bind to the proxy
   network or firewall it), as for the IP allowlist (`lib/security/.claude.md`).
3. Pin the certificate on the client by its SHA-256 fingerprint (required; 64 hex
   characters, colons and case ignored): `openssl x509 -in client.pem -noout -fingerprint -sha256`.
   Optionally also pin the subject DN: it is compared as ONE exact string against
   `X-SSL-Client-DN`, so enter it exactly as the proxy emits it (RFC 4514). The app does
   not parse or normalise DNs: reordered RDNs, the OpenSSL slash form (`/C=LS/CN=...`), other
   case and `+` multi-valued RDNs written differently do not match. A client that requires
   mTLS without a fingerprint is refused by the form, the CHECK constraint and the check itself.
4. Header names are configurable: `MTLS_VERIFY_HEADER`, `MTLS_DN_HEADER`,
   `MTLS_CERT_HEADER`.

Not done here: the proxy's own configuration, certificate issuance and rotation,
and revocation lists (OCSP / CRL) belong to the ingress; the app only revokes the client.
