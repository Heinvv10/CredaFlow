<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: i18n
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Borrower-facing languages (en, af, zu, xh) for the public website, the client
portal and borrower comms. The staff app, the NCA documents (`lib/pdf`),
legal / consent text and, for now, the portal lease pages
(`components/portal/lease/`) stay English.

## Critical Rules
- **English is the source of truth.** `messages/en/*.ts` defines every key and
  `{placeholder}`; a translation file typed `Catalog[...]` fails to compile on a
  missing or extra key, and `catalog.test.ts` also checks placeholders, markup
  tags and the MACHINE DRAFT header. Add a key to all four languages at once.
- **af/zu/xh are machine drafts.** Enabling one needs a named native-speaker
  review acknowledgement (`TenantConfig.languageReviews`) pinned to the
  catalogue's hash; no record, or text edited since, means not served. One
  audited write path, `language-settings.ts`. The seed's records are demo-only:
  never give a real lender one.
- **Never translate statutory, consent or collections text**: Section 129
  (incl. its portal labels), credit agreement, PASQ, debit mandate, the decline
  reason, overdue notices, POPIA/consent, FAIS, registration lines. Leave them
  English and say so in the namespace's header comment.
- **English output must not change.** Comms English is pinned by digest
  (`lib/email/templates/english-pinned.test.ts`); product copy and WhatsApp text
  have equality tests against their original sources.
- **Money stays `formatZAR`** (matches the PDFs). af/zu/xh dates go through
  `format.ts` (CLDR tables: Chrome has no zu/xh Intl data; hydration fails).
- **No locale in the URL.** `server.ts` resolves cookie → client profile →
  Accept-Language, only within the tenant's enabled languages.
- **Client components use `useT(ns)`**; the namespace must be listed in
  `surfaces.ts` (checked by `surfaces.test.ts`). Server components use `getT`,
  or `createTranslator(locale, ns)` when they take a `locale` prop. Never import
  `catalog.ts` into a client component (it bundles all four languages).

## Key Files
| File | Purpose |
|------|---------|
| `lib/i18n/locales.ts` | Codes, negotiation, tenant list normalisation |
| `lib/i18n/server.ts` | `getLocale`, `getT`, `clientMessages` |
| `lib/i18n/client.tsx` | `I18nProvider`, `useT`, `useLocale` |
| `lib/i18n/comms.ts` | Comms language + WhatsApp template variant rows |
| `lib/i18n/language-reviews.ts` | Review records, update validation |
| `app/actions/locale.ts` | The switcher's write (cookie + `Client.preferredLanguage`) |

## Common Tasks
| Task | Pattern |
|------|---------|
| Regenerate `messages/<l>/index.ts` | one import + entry per namespace file |
| WhatsApp template in a language | row keyed `<key>__<locale>`, `language` = locale, Meta-approved |
