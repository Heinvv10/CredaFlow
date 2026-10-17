# G06-U follow-up — operator sign-out remains on its host

Base: `66c183c1d316b2c8d696b56aa37a42de4700445e`. Isolated branch: `fix/gtm-operator-signout-20261017`. Owner A; writable paths are the two operator components, their adjacent tests and this record. No helper or global Auth.js change.

## Actual reproduction and smallest change

Coordinator reproduced the boundary against the final66 private immutable image: a same-origin anonymous POST to `/api/auth/signout`, with real CSRF and the exact next-auth/react return-redirect fields, returned `http://localhost:44213/operator/login`. Following that actual URL reached404. Both the ordinary operator sign-out and post-enrolment "Sign in again" used `signOut({ callbackUrl: "/operator/login" })`; Auth.js resolves the callback against the configured canonical staff origin. This is separate from the already corrected proxy redirects. Private reproduction: `/tmp/cf-gtm-coordinator-20261017/operator-anonymous-signout-boundary.log`.

`OperatorSignOut` now awaits the existing `signOut({ redirect: false })` protocol, ignores its returned canonical URL and then performs a full navigation to the fixed relative `/operator/login` on the current host. The post-enrolment action reuses this component with its original label and default button variant, avoiding duplicate sign-out logic. Ordinary sign-out retains its outline button variant. Pending requests disable the action and an immediate guard prevents duplicate requests. A thrown transport failure shows an alert and enables retry without navigation.

The one local Next lint exception documents the deliberate full page reload: ending the held/enrolled session view must return to this host's fresh login, rather than follow the Auth.js canonical staff destination. No global redirect allowlist, callback validation, CSRF, session invalidation, operator host gate, mandatory TOTP or role policy changes. No database/migration or provider implications.

## Verification

- Fail first: both new adjacent suites failed all4 meaningful tests on the unchanged base components. Private `/tmp/cf-gtm-a-browser-20261017/operator-signout-failfirst.log` retained.
- `npx vitest run components/operator/OperatorSignOut.test.tsx components/operator/OperatorTotpEnrol.test.tsx lib/proxy/operator-host.test.ts --maxWorkers=2` on CPUs0–3: 3 suites/40 tests PASS. New tests defer sign-out, poison the returned staff URL, verify no early navigation, bound duplicate clicks, check rejection/retry and drive successful enrolment into the real shared sign-out component. All React test roots unmount inside awaited act before global cleanup.
- Changed-file ESLint: PASS without warnings after the narrowly documented full-navigation exception.
- Frozen-source `npm run ci:quick` on CPUs0–3: running; queue admission awaits exact completion.

## Required combined/browser acceptance

Independent B source review and final integrated quality/integration/image gates remain mandatory. On the resulting exact immutable image, keep canonical NEXTAUTH_URL configured. A newly enrolled operator must click actual "Sign in again", remain on the operator host at `/operator/login`, then authenticate with the next valid code. Ordinary operator sign-out must similarly clear the session and reach operator login; protected console navigation must not remain authenticated. Verify no cross-host404, CSRF or redirect allowlist workaround and no browser errors. Prior candidate66 portal passes and root's failing operator reproduction do not establish this new source passes those browser scenarios.
