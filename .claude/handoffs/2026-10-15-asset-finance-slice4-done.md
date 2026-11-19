# Handoff: asset finance slice 4 (2026-10-15, 23:25 SAST)

**Goal:** `.claude/handoffs/2026-10-15-asset-finance-slice4-goal.md`
**Specs:** `docs/asset-finance/SLICE4.md` (4a), `docs/asset-finance/DESIGN.md` (slice 4a and 4b sections)

## Status

- **4a (recovery, remarketing, costs, VAT, legal matter):** PR #111, MERGED 15:05 SAST via mq.
- **4b part 1 (AF journal sources and tie-out on #89's engine):** PR #118, MERGED 23:40 SAST (21:40Z) at 8231e4d7. ci:full green: 287 integration suites. Check `mq status`.
- **4b part 2 (IsaFlow draft push):** NOT BUILT. It is blocked on Hein's decision G1, below.
- **Nothing deployed.** There's no production path. A demo or Fairscore rebuild needs Hein's approval and has to run after hours.

## Success criteria (§7)

1. **Recovery pipeline: met.**
   - `recovery-e2e.integration.test.ts` runs all four routes end to end through the real handlers.
   - The surrender suite is unchanged.
   - Every DB rule is mutation-verified, and `recovery-migration-coverage.test.ts` is a static gate that every rule has a removal test.
2. **Legal matter: met.** The tests cover:
   - the s129 + 10 business-day summons wait;
   - the NON_NCA letter-of-demand rule;
   - ASSET_RECOVERED creating the recovery;
   - the bell reminder;
   - the L being proposed only (the bureau tests are unchanged).
3. **Costs, VAT and sale: met.**
   - Eight synthetic recoveries, two per route, are worked independently to the cent: `__fixtures__/acceptance-recovery-deals.ts`. All eight run through the real routes in `recovery-gaps-deals`.
   - Below-valuation, related-party and self-valued sales need a second approver, enforced in the DB and mutation-verified.
   - Sales, costs and VAT events are immutable.
4. **Post-sale: met.**
   - Charges freeze, then accrue again (tested with a clock).
   - The surplus refund needs three people and standing proceeds.
   - Write-off is never automatic.
5. **Browser acceptance: met.** `docs/asset-finance/evidence/slice4/README.md`, with TOTP on, light and dark, 390 px, and the portal. There is also an independent browser review (APPROVED).
6. **Seed: met.** An s131 recovery at SHORTFALL_OPEN and a NON_NCA lease recovery that is LISTED. Seeding twice is clean (seed IT).
7. **4b: partly met.**
   - Month tie-out with AF sources passes, plus six controls. Evidence is in `docs/asset-finance/evidence/slice4b/`.
   - The fake IsaFlow IT and the live dev-company push: **blocked on Hein (G1, G2).**
8. **Every PR: met for both PRs.**
   - ci:full green.
   - Blind review team: quality, security, TDD, architecture, absence and browser.
   - Fix-commit reviews to SHIP or code-closed.
   - An adversarial tester on #111 (3 rounds) and #118. Its repros are committed as integration tests: `lib/asset-finance/recovery-break*`, `lib/accounting/af-break*`.
9. **Wrap-up: met.** UNTESTED markers, DESIGN.md, this handoff, LATEST.md and memory.

## Decisions owed by Hein

- **G1 (blocks the IsaFlow push).** Decision 9 said to use "IsaFlow REST journal endpoint, external_ref, not MCP". IsaFlow's `pages/api/accounting/journal-entries.ts` only accepts a browser session cookie (no Bearer token or API key) and has no `external_ref`.
  - The only machine path is `/api/mcp` `create_draft_journal`: a PAT, a server-side `idempotency_key` with replay, never auto-posts, and `list_gl_accounts` for chart checks.
  - Options:
    - (a) build on MCP behind a swappable transport now;
    - (b) commission IsaFlow to add Bearer auth and `external_ref` to the REST endpoint first.
  - The design is in the 4b spec §2.4–2.5: scratch copy `/tmp/claude-1003/-home-hein-Workspace-CredaFlow/17fe9f95-79fb-4b1a-a762-c70227d4e1e8/scratchpad/SLICE4B-spec.md`. Copy it into docs if you go ahead.
- **G2.** The dev IsaFlow company, a PAT (`write:journals`, `read:reports`), `mcp_connector` enabled, Flow credits, and the base URL.
- **Q4 (accounting catch-up).** The default is built: AF history that predates the first open month posts in that month, dated by origin. Confirm, or ask for AF opening positions instead.
- **Demo/Fairscore rebuild.** Approve, after hours.

## Legal and tax sign-off pending (all `// UNTESTED:`)

**4a:**
- the cost-type allow-lists;
- s127(8) and the NON_NCA demand deadline;
- s8(10)/s10(10) deemed-supply VAT;
- taxed costs inside in duplum;
- the lender absorbing costs the ledger can't carry;
- every new notice line (DRAFT watermark; existing surrender wording unchanged);
- the label "Costs of recovering the goods".

**4b:**
- inception input VAT;
- interest recognised as it falls due;
- maintenance-claim input VAT;
- charged-cost VAT;
- the recovery result account;
- lease NBV derecognised in IsaFlow;
- fee VAT not split for AF;
- VAT history at go-live to be cleared by the accountant.

## Known limits / follow-ups

- **Screening** doesn't catch typos, businesses named only by surname, or 2-digit years. Evidence file content isn't validated.
- **NCA charge freeze** is open-ended between the proceeds and the final notice.
- **Legacy `creditSurrenderProceeds` race** is refused with a 409, but can leave an applied receipt unlinked.
- **AF credit notes** on IS inception or repossession-sale invoices refuse the close (AF_SOURCE_UNSUPPORTED).
- **Portal recovery card** is not translated (W7 i18n).
- **Recovery deadline cron** has no route unit test (integration-covered).
- **Pre-existing on main:** the s127 surrender notices print the address with "?" separators (`pdf-layout.ts` wrapText; fixing it changes NCA renders).
- **Pre-existing:** the server and client permission maps disagree (#110 handoff).
- **Worktrees to remove after #118 merges:**
  - `CredaFlow-af-s4`, `-af-s4-merge`, `-af-s4b`, `-s4-break`;
  - `CredaFlow-s4-uirev`, which should already be removed.

## Next steps

1. Watch `mq status` and `mq log` for #118. If it is ejected as BEHIND, merge main into it and rerun ci:full.
2. Once G1/G2 are answered, build WP-B (the IsaFlow connection, push, fake server and ITs) from the 4b spec on a new branch, then follow the same review and breaker loop.
