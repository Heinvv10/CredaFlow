# /goal — Dependency security upgrades: clear critical + high npm audit findings (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-15-dependency-security-upgrades-goal.md to completion. Work autonomously through Audit → Upgrade → Verify → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§6) or a genuine external blocker. Loop until every Success Criterion (§5) is proven with evidence, then open the PR(s), queue them with mq, write a handoff and stop.`

## 1. Mission

`npm audit` on `origin/main` (2026-10-15, lockfile at merge of #89) reports **1 critical, 27 high, 34 moderate**. Bring critical and high to **zero** (or, for any that genuinely can't be fixed, document why with the exploitability analysis), with no behaviour change: every test green, NCA PDF render hashes unchanged, face-model tests unchanged, the app builds and boots in Docker, and the key flows work in a browser.

## 2. What already exists — do NOT redo

- Start: `git fetch origin && git checkout -b chore/dependency-security-upgrades origin/main`; `npm ci --legacy-peer-deps` (plain `npm install` leaves an incomplete tree — next-auth beta peer conflict; keep using `--legacy-peer-deps`).
- Gates: `npm run ci:quality` (tsc, lint, unit tests incl. pinned NCA render hashes `lib/pdf/charges-off-identity.test.ts`, face-model tests, production build), `npm run ci:integration` (disposable Postgres), `npx tsx scripts/nca-pdf-fingerprint.ts` (all 9 pinned hashes must match), `.github/workflows/quality-gate.yml`, `Dockerfile`.
- Merge only through the queue: `mq add <pr>`; agents can't `gh pr merge`. Test DBs only via `scripts/it-db.sh up|check|down`.

## 3. Findings to clear (from `npm audit --package-lock-only --json` on main)

| Package | Sev | Direct? | Used by | Notes |
|---|---|---|---|---|
| `next` (^16.2.12) | critical | dep | whole app | non-breaking fix available — upgrade to the latest patched 16.x |
| `eslint-config-next` / `@next/eslint-plugin-next`, `braces`, `fast-glob`, `micromatch` | high | dev | lint | audit suggests a *downgrade* to 14.x — **ignore that**; upgrade eslint-config-next to the version matching the new `next` |
| `puppeteer` (^24.40.0) + `puppeteer-core`, `@puppeteer/browsers`, `basic-ftp`, `extract-zip`, `get-uri`, `pac-proxy-agent`, `proxy-agent` | high | dep | `lib/documents/html-to-pdf.ts` | audit suggests a downgrade to 19.x — **ignore**; upgrade to latest 24.x/25.x patched, or use `overrides` for the transitive ones |
| `sharp` (^0.34.5) | high | dep | `lib/kyc/biometric-image.server.ts` (face-match pipeline) | fix is 0.35.x (semver-major for 0.x); face-model tests and `face-match-v3-*` integration suites must stay green |
| `nodemailer` (^9.0.3), `mailparser`, `html-to-text`, `deepmerge-ts` | high | dep | `lib/email/*` (outbound + inbound poll) | audit's "next-auth@1.12.1" suggestion is nonsense — **ignore**; upgrade nodemailer/mailparser directly; check next-auth's peer range |
| `@tiptap/core`, `prosemirror-view` | high | transitive | editor UI | non-breaking |
| `brace-expansion`, `ip-address`, `js-yaml`, `nanoid`, `postcss`, `source-map-js`, `undici` | high | transitive | various | non-breaking (`postcss` is pinned `8.5.12` in package.json — bump the pin) |

**Rules** `[agent decides details]`:
- Never accept an audit "fix" that downgrades a major version. Prefer upgrading the direct dependency; use `overrides` in package.json only for transitive packages whose parents haven't released a fix, and comment each override with the advisory id.
- Do it in small, separately verifiable commits (or 2–3 PRs: `next` + eslint; email stack; puppeteer/sharp/other) so a regression bisects cleanly. `[agent decides PR split]`
- Re-run `npm audit` after each step; record before/after counts.
- Read each upgraded package's changelog for breaking changes affecting how CredaFlow uses it (grep usages) and adapt code minimally.

## 4. Verification per area

- **next:** full build; dev server + production build boot; browser-check staff sign-in with TOTP, portal sign-in, a settings save (exercises the cross-origin gate), a document view; middleware/proxy tests (`proxy*.test.ts`) green.
- **email (nodemailer/mailparser):** unit tests for `lib/email/*` green; the English-pinned email digests (`lib/email/templates/english-pinned.test.ts`) unchanged; inbound-poll tests green. No real email sent (use the existing test transports).
- **puppeteer:** `lib/documents/html-to-pdf.test.ts` green; render a document locally and compare output (byte or visual) with main's.
- **sharp:** face-model tests (part of `ci:quality`) and `RUN_*` face-match integration suites unchanged; biometric image normalisation output identical for the test fixtures (add a hash test if none exists, generated on main BEFORE upgrading).
- **NCA PDFs:** `scripts/nca-pdf-fingerprint.ts` hashes identical.
- **Docker:** `docker build` succeeds and `/api/health` returns 200 on a local container.

## 5. Success criteria

1. `npm audit --omit=dev` shows 0 critical and 0 high, and `npm audit` (incl. dev) shows 0 critical and 0 high, or each remaining one is documented in the PR with advisory id, reachability analysis and why it can't be fixed yet.
2. `ci:quality` + `ci:integration` green; NCA fingerprint identical; face-model and biometric hashes identical.
3. Browser checks in §4 done and described.
4. Docker build + boot OK.
5. Blind `/review` and a security review SHIP; findings fixed.
6. PR(s) opened and queued with `mq add`; handoff written.

## 6. Confirmation gates (stop and ask Hein)

- A dependency whose only fix requires a breaking change that alters behaviour (output of NCA PDFs, face-match scores, email content, auth/session behaviour).
- Replacing a dependency with a different library.
- Upgrading `next-auth` off the current v5 beta line.
- Anything touching production or the demo/Fairscore stacks.
