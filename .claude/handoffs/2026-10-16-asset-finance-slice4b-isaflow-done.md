# Handoff — 2026-10-16 ~11:05 SAST: asset finance slice 4b part 2 (IsaFlow) + slice-4 follow-ups

**Goal executed:** `.claude/handoffs/2026-10-16-asset-finance-slice4b-isaflow-goal.md`
**Status:** all three PRs built, reviewed to SHIP, `ci:full` green, queued with `mq`.
- #128 (F3) and #130 (IsaFlow) are MERGED.
- #131 (F1/F2/F4/F5) MERGED 09:28Z.
- **The live IsaFlow dev push is BLOCKED ON HEIN** (§9, inputs below).
- Nothing deployed; no demo/Fairscore rebuild.

## PRs
| PR | Branch | What | State |
|---|---|---|---|
| #128 | fix/af-credit-note-sources | F3: AF credit notes on IS/FL inception and repossession-sale buyer invoices post and tie (new role `AF_PRICE_CREDITS`, 6400) | MERGED |
| #130 | feat/af-isaflow-push | IsaFlow connection + draft-journal push over MCP, fake IsaFlow, UI, migration `20261016100000_isaflow_connection_push` | MERGED 08:46Z |
| #131 | fix/af-slice4-followups | F1 address line breaks, F2 final-notice reminder, F4 portal card i18n, F5 cron route test | MERGED 09:28Z |

## Success criteria (§8)
1. **IsaFlow: done, against the fake.**
   - ITs pass: two pushes give one draft; commitThenDrop → read-back → PUSHED with no second create; unmapped/unknown codes are refused before any send. Guards are mutation-verified (`docs/asset-finance/evidence/slice4b-isaflow/MUTATIONS.md`).
   - Browser run (12 screenshots + README in `docs/asset-finance/evidence/slice4b-isaflow/`): connect as a TOTP SUPER_ADMIN → close a month → push → re-push 409 with no IsaFlow call. The dev server's clock was shifted +17 days so a month with journals could close; the README says so.
2. **Live dev push: DONE** (see "Live IsaFlow push" below). Originally blocked on Hein. Needed:
   - the dev company;
   - a PAT with `write:journals` + `read:reports`;
   - `mcp_connector` enabled for that company;
   - Flow credits;
   - the base URL, to put in `ISAFLOW_ALLOWED_ORIGINS`.

   Then connect it on a local/dev stack and push one closed month; record the draft id here.
3. **F1: done.** No pinned hash moved (the pins use one-line addresses), so nothing was re-pinned. Multi-line renders change only in the address. Proof: `docs/asset-finance/evidence/f1-s127-address/README.md`. The wording diff is empty.
4. **F2: done.** Clock IT with pinned dates (weekend; Easter 2027 plus the Human Rights Day Monday): no reminder before day 5, one on day 5, still one after reruns, no state change.
5. **F3: done.** Hand-worked fixtures (IS, IS early, FL, IS written off, sale credit) post and tie; the AF_SOURCE_UNSUPPORTED cases for these two are gone; mutations M1–M13 (`docs/asset-finance/evidence/f3-credit-notes/MUTATIONS.md`).
6. **F4/F5: done.** Portal screenshots in af and zu: `docs/asset-finance/evidence/f4-portal-i18n/`.
7. **Every PR:**
   - `ci:full` green;
   - blind reviewers;
   - an independent edge-case tester whose repros are committed as tests;
   - fix commits re-reviewed to SHIP;
   - queued with `mq`.
8. **Docs:** DESIGN.md and `lib/accounting/.claude.md` updated; memory updated; this handoff written.

## Live IsaFlow push: DONE (2026-10-16, afternoon)
- **Target:** production IsaFlow (`app.isaflow.co.za`), company **ISAFlow Demo (Pty) Ltd** (`00000000-0000-0000-0000-000000000001`). `mcp_connector` was already on. Hein is linked as Bookkeeper.
- **Token:** PAT "Credaflow" (all scopes, expiry 14 Jan 2027), created and pasted by Hein. **REVOKED 2026-10-16**; ISAFlow Demo now has no tokens.
- **CredaFlow side:** a local stack from main (worktree `CredaFlow-isaflow-live`, DB container `cf-dev-live`, port 3391, JS clock shifted so months could close).
- **Mapping:** CredaFlow's roles were remapped onto ISAFlow Demo's leaf accounts: 1110 bank, 1120 receivables, 1140/2120 VAT, 4310 interest, 4300 fees/other income, 4200 maintenance, 2110/2130 payables, 5500/5600 expenses, 3300 opening equity.
- **Result:** December 2026 (4 entries, R 25,960.75 each side) was pushed and is in IsaFlow as **draft JE-2026-02781**, id `e36a0087-97ba-4f52-992d-724b229b10ee`, dated 2026-12-31, memo tag `[credaflow:66d44457-ad99-4d79-b8ea-28eb663aa6ad]`. A re-push was refused with 409 ("already in IsaFlow").
- **Before that:** October and November were refused before any claim (422 listing missing codes), and nothing was created. That's the chart check working.
- **Found:** IsaFlow's admin "Remove company link" fails for ISAFlow Demo. Its id `00000000-…-0001` is not RFC-4122, and that route's validator rejects it (see IsaFlow `src/lib/schemas/common.ts` note; this route wasn't switched to `z.guid()`).
- **Found:** the IsaFlow onboarding wizard requires a CIPC certificate to create a company, so test companies have to go through the admin console.
- **Cleanup:** PAT revoked; `cf-dev-live` and the `CredaFlow-isaflow-live` worktree torn down. Draft JE-2026-02781 **remains**: IsaFlow has no delete for draft journals (UI or API; `journal-entries-action.ts` has only post/reverse). Removing it needs a prod DB delete (Hein's call). As a draft it affects no balances.

## Decisions taken during the run (worth Hein's eye)
- **F4 i18n:** `lib/i18n/.claude.md` says never translate collections/statutory text, so the recovery card's statuses, notice names, figures, shortfall/surplus and freeze line stay English. Only the heading ("Recovery of your asset"), the description, "Notices issued" and "None yet" are translated. **The lender's legal team should OK the translated heading** before a real lender enables af/zu/xh.
- **F4 side effect:** the af/zu/xh catalogue hashes change, so on the next demo/Fairscore rebuild the language reviews need re-acknowledging (or a reseed), or af/zu/xh stop being served.
- **F3 policy points** (in DESIGN.md, for the lender's accountant):
  - A full credit on a deposit deal leaves AF_INSTALMENT_DEBTORS in credit.
  - Dealer input VAT stays claimed until the dealer credits.
  - A buyer-invoice credit note lands in the recovery result; it doesn't reduce the proceeds already credited to the debtor.
- **IsaFlow design deviations, accepted:**
  - Connect uses `list_companies` (company_profile has no id).
  - `requestJson` is stored as TEXT with a DB sha check, so resends are byte-for-byte.
  - `superAdminPolicyWrite` gained an optional, side-effect-free `prepare` step.
  - Loopback http is allowed in dev only when the origin is listed.
  - A draft deleted in IsaFlow can't be recreated under the same key: the push waits in NEEDS_REVIEW, and the advice is to post that month from the CSV.
- **F2 recipient:** if the creator is inactive, the tenant's active ADMIN/SUPER_ADMIN users get the bell. With nobody, no marker is written, a `console.warn` is logged (the repo has no logger) and it retries daily.

## Follow-ups (not built)
- IsaFlow: push-side error text isn't passed through `redactTokens` (security LOW; matters only if IsaFlow echoes a token).
- IsaFlow: Xero's IT uses `rejects.toThrow(/regex/)` with Prisma's default errorFormat, which quotes the test source, so some of its guard assertions can't fail (`lib/accounting/xero/xero.integration.test.ts`). Fix with `errorFormat: "minimal"`, as the IsaFlow guards IT does.
- F1, pre-existing: `wrapText` drops blank lines, and an unbroken token wider than the line overflows the margin.
- F2: the fallback bells every ADMIN regardless of asset-finance permission. A tenant with no active admin only logs a warning.
- Repo: no logger module. CLAUDE.md "no console" can't be met; decide on one.
- `scripts/ci-local.sh` builds over an existing `.next`; a stale cache produced a false TS2859 on #131. Consider `rm -rf .next` in the build step.
- Seen, not investigated: on the seeded portal, the TLB loan showed outstanding R285,959 next to a shortfall owed of R374,696. Check whether the loan header should reflect the recovery account.
- `lib/accounting/.claude.md` is 55 lines (the guideline is under 50).

## Cleanup
Done (Hein approved): session worktrees, merged branches, /tmp tester clones and all containers removed.
