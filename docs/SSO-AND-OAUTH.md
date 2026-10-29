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
- SAML: assertion consumer URL `<NEXTAUTH_URL>/api/auth/sso/saml/acs` (HTTP-POST),
  audience = the service-provider entity id typed in CredaFlow, assertion signed
  (SHA-256 or better), NameID or an attribute holding the email, bearer
  `SubjectConfirmationData` with `Recipient` = the ACS URL and `InResponseTo`.
  Sign-in always starts at CredaFlow; an unsolicited (IdP-initiated) response is refused.

Who gets in:

- Allowed email domains are required before SSO can be switched on.
- The identity provider's email must be verified (OIDC `email_verified` true; a
  missing claim is refused unless the lender ticks "Accept emails the provider does
  not mark as verified"; SAML assertions are signed by the lender's provider and
  taken as verified) and must equal a staff user's email in THAT lender, once. That
  first sign-in binds the provider's stable subject (OIDC issuer+sub, SAML IdP entity
  id+NameID) to the user. From then on the subject decides: a different subject
  presenting that email is refused. Changing the provider (protocol, issuer, entity
  id) clears the bindings; people then re-link by email at their next sign-in.
- Nothing is created unless "Create staff accounts on first sign-in" is on (off
  by default). A Super Admin or operator user is never created, mapped or changed
  by the provider (also enforced by CHECK constraints on `SsoConnection`), and a
  Super Admin cannot sign in through the provider: password plus authenticator code only.
- Group to role mapping: a user in mapped groups gets the highest mapped role at
  each sign-in (audited `SSO_ROLE_SYNCED`); a user in none keeps their role.
- Optional allowed email domains.

### Second factor: what SSO changes and what it does not

- A user who enrolled CredaFlow TOTP is always asked for the code after the
  provider returns them. `totpVerified` (which gates identity, user, API-key and
  OAuth-client writes) therefore keeps meaning "a CredaFlow code was checked".
- A user with no CredaFlow TOTP, when the lender requires staff 2FA, is held at
  the enrolment page, unless the lender ticked "Trust the provider's MFA" AND the
  provider reported MFA for that sign-in (OIDC `amr` holding `mfa`, or factors of
  two types; or an `acr` / SAML AuthnContext the lender listed or a standard MFA
  class). That session works, but cannot do `totpVerified`-gated writes: enrol
  CredaFlow TOTP for those. The trust is re-read on every request: switching it
  off holds unenrolled users from their next request.
- If the provider did not prove MFA, nothing is waived.

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
| `SSO_ALLOW_PRIVATE_IDP` | `1` lets the OIDC discovery, token and JWKS requests reach a private address (an identity provider on the lender's own network). Default: public addresses only, https only |
| `AUTH_SECRET` | the staff container's; sign-in tickets, flow state and OAuth access tokens are signed with keys derived from it |

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

## 3. Mutual TLS

TLS is terminated and the client certificate verified by the ingress / reverse
proxy, never by the app. The app trusts what the proxy forwards ONLY when
`MTLS_TRUSTED_PROXY=1` (off by default) and only for OAuth clients registered
with "Require a pinned TLS client certificate". Such a client is refused when the
proxy is not trusted (it fails closed), at the token endpoint AND on every API
call, so a stolen token is useless without the certificate.

Proxy duties (nginx shown; the same for HAProxy, Envoy, an ingress):

    # only for the API host / location
    ssl_client_certificate /etc/ssl/lender-client-ca.pem;   # the CA the lender issues client certs from
    ssl_verify_client optional;
    location ~ ^/api/(v1|oauth)/ {
      proxy_set_header X-SSL-Client-Verify  $ssl_client_verify;     # "SUCCESS" or not
      proxy_set_header X-SSL-Client-DN      $ssl_client_s_dn;
      proxy_set_header X-SSL-Client-SHA256  $ssl_client_fingerprint; # nginx gives SHA-1 here: use a sha256 variable or the Lua / njs equivalent
      proxy_pass http://app;
    }

Rules that make this safe:

1. The proxy MUST set these three headers on every request, overwriting any the
   caller sent (an empty value if there is no certificate).
2. The app port must be unreachable except through the proxy (bind to the proxy
   network or firewall it), as for the IP allowlist (`lib/security/.claude.md`).
3. Pin the certificate on the client by its SHA-256 fingerprint (required; 64 hex
   characters, colons and case ignored). Optionally also pin the subject DN: it is
   compared as ONE exact string against `X-SSL-Client-DN`, so set the proxy to emit RFC 4514
   form (nginx: `$ssl_client_s_dn`) and enter the DN as the proxy writes it. The app does
   not parse or normalise DNs: reordered RDNs, the OpenSSL slash form (`/C=LS/CN=...`), other
   case and `+` multi-valued RDNs written differently do not match. A client that requires
   mTLS without a fingerprint is refused by the form, the CHECK constraint and the check itself.
4. Header names are configurable: `MTLS_VERIFY_HEADER`, `MTLS_DN_HEADER`,
   `MTLS_FINGERPRINT_HEADER`.

Not done here: the proxy's own configuration, certificate issuance and rotation,
and revocation lists (OCSP / CRL) belong to the ingress; the app only revokes the client.
