<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: lib/ (session and audience rules)
<!-- summary: session and audience rules; a portal credential change ends client sessions -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Gotchas for the session code in `lib/` that are not obvious from one file.
Module-specific rules live in the nested `.claude.md` files (see root).

## Client sessions end when the portal credential changes
- A CLIENT JWT carries `credentialStamp`: a keyed HMAC (`AUTH_SECRET`) of the
  stored `portalPassword` hash (`lib/client-session.ts`), bound to client id and tenant. The jwt callback in
  `lib/auth.ts` revalidates it on every refresh; a changed hash, a cleared
  password, a missing row or a token with no stamp ends the session.
- The Client table has no tokenVersion, so the hash IS the version. Adding any
  new way to change `portalPassword` ends every session of that client. That
  is intended; the one caller that must keep its own session
  (`app/api/portal/password/route.ts`) re-issues its cookie through
  `lib/client-session-cookie.ts`.
- The password change writes with a compare-and-swap on the hash it verified
  (`updateMany`, 409 on a lost race): a reset landing during the bcrypt must
  win and must not be re-stamped.
- Re-issue the cookie in the route, never from the jwt callback's `"update"`
  trigger: `POST /api/auth/session` reaches it too, so a stale session could
  re-stamp itself.

## ORDER DEPENDENCY: the route's Set-Cookie must come last
The edge proxy (`proxy.ts` via `lib/auth-edge.ts`) re-issues the session cookie
with the OLD stamp on every request, and Next emits the route's own
`Set-Cookie` after it. Browsers apply cookies in order, so the new stamp wins
only while that order holds. A Next upgrade that reverses it would sign the
client out of the session that just changed its password, with no error.
`app/api/portal/password/route.integration.test.ts` starts `next dev` and
asserts the LAST session-token cookie carries the new stamp. It is gated like
the other real-DB suites (`RUN_DB_IT=1`, swept by
`scripts/run-integration-tests.sh`): re-run it on every Next upgrade.

## A host serves one audience
- `roleRefusedOnThisHost` (`lib/auth-config.ts`) is applied by the jwt callback
  in `lib/auth.ts` and the edge config: `APP_MODE=client` honours only CLIENT
  tokens, `APP_MODE=staff` only staff ones, unset or `all` both. It reads
  `APP_MODE` per call and holds even when both hosts share a signing secret.
- `authorize()` refuses the other audience's `loginType` the same way.
- The matcher excludes no extensions; only GET/HEAD of the files listed in
  `lib/proxy/static-image.ts` (= the images in `public/`) skip the proxy. A
  dynamic segment can take "x.png", so a suffix alone decides nothing. Client
  host `/api/auth/*` is NextAuth's endpoints plus `expired`, not the staff
  forgot/reset-password handlers.
- Client-host pages are an allow-list in `proxy.ts` (`isUnlistedPage`); the
  route tree is enumerated in `proxy.client-pages.test.ts`, so a new top-level
  page fails that suite until it is classified.
