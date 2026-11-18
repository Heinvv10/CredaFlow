# Handoff — 2026-11-02 11:25 SAST — LPB tender build done

**Project:** CredaFlow. **Main:** 4b242b88 (#289 merged 10:53). The main checkout is stale; work from origin/main in a fresh worktree.

## Done
- #289 merged through mq. Every LPB build PR is on main: #275, #277, #279, #282, #290, #291, #281, #293, #292, #280, #294, #289. ZA NCA fingerprints unchanged, no re-pin.
- Browser walk on final main: fresh IT DB, `DEMO_LENDER=basotho` seed, no SQL. Six real roles, all with staff TOTP: borrower applies (key facts statement required before submit) -> credit.officer starts the review -> loan.admin.one clears NO_STATEMENT with a reason and approves -> borrower accepts the offer, acknowledges key facts, signs with an OTP -> admin records in-person KYC -> payout.confirmer confirms the account -> loan.admin.two pays out (manual EFT, bank ref) -> M500 receipt allocated -> arrears letter issued on LN-SEED-0001. Shots: `lpb-artifacts/shots/final-main-walk/` (17).
- Evidence page: https://claude.ai/artifact/8Pm9MsLsU3RXAPQCcGBoVk (walk, A3/A5b/F7 branch shots, PRs with SHAs, mutation and breaker results). Source: session scratchpad `evidence/lpb-evidence.html`.
- Compliance rescore on final main: `lpb-artifacts/compliance-summary.json` (adds `previousStatus` and a dated `roadmap` on every Partial), with `compliance-summary-0da7d4b6.json` as the old copy and `compliance-summary-notes.md` (rescore section on top). Published: https://claude.ai/artifact/3CuvQn1X57KdZpsvBDHY41. **20 Comply / 51 Partial / 33 Fail; T1 to T6 all still Fail.**
- Status log, memory and MEMORY.md updated. Removed the worktrees CredaFlow-lpb-a10b-c and CredaFlow-lpb-walk and the container cf-it-lpbwalk (`docker rm -fv`).

## Not done
- **Demo re-bake with the Lesotho lender:** Re-bake NOT possible as-is (checked 2026-11-02 11:45): Hein chose a NEW basotho stack (basotho./basotho-staff.credaflow.com), but scripts/demo/simulate has no KEY_FACTS/Lesotho path (0 hits; 24 PASQ/debit-order/mandate steps), so bake.sh cannot build a Lesotho snapshot. Needs either simulator LS support (builder work, after 8 Nov) or a seed-only live stack from DEMO_LENDER=basotho (no history; restore.sh only restores snapshots). Then: Cloudflare public hostnames on tunnel credaflow-demo (Hein, dashboard), ports 3350/3352/5486 (3340 is taken), SSO_SECRET_KEY generated into the new .env.production.

## Walk findings (follow-up PRs, not started)
1. About 15 form labels still say "(R)" on an LS lender: `lib/i18n/messages/en/portal-apply.ts:43` incomeR, website-apply netIncome, `components/clients/wizard/Step3Employment.tsx`, `ExpenseBreakdownSection.tsx`, `LoanCalculator.tsx`, `Step2LoanParams.tsx`, `ClientFormLegacy.tsx`, `crm/ConvertLeadForm.tsx`. Use the active currency symbol.
2. The seeded walk borrower's bank statement is dated 2 years back (`prisma/seed/key-facts-walk.ts` LONG_AGO), so a new application opens with NO_STATEMENT. Either seed a recent statement or document the clear step in the demo script.
3. Tooling note, not a bug: the chrome-devtools `fill` sometimes does not update React state for selects and textareas (KYC in-person form, payout account confirmation). `document.execCommand('insertText')` works.

## Waiting on Hein
- Send the Fair Score email (draft `lpb-artifacts/email-fairscore-lpb-early-draft.md`). Items 1.2 (live at a regulated institution) and 7.1 (three bank references) decide whether the bid can pass, and only Fair Score can clear them.
- Agree the clarification questions (`clarification-questions-draft.md`, 24 questions) before 12 Nov 16:30 CAT to erptender@lpb.co.ls.
- Key rotation: GITHUB_TOKEN, EXA_API_KEY, GROQ_API_KEY and a messaging token were printed into the lpb-a5b transcript (none reached the repo).
- Spend: QSA (PCI 4.1), pen test (4.8), vault/KMS (4.2 to 4.4), Postgres support (5.16).
- Lesotho demo stack choice (above).

## Next session
Builders are rate-limited until 8 Nov 06:00 SAST. Next: the "(R)" label sweep PR; the roadmap items dated 13 Nov (DPD bands) and 20 Nov (batch catch-up + README, eligibility, statements API, sandbox, manuals); Tier B once Fair Score answers 1.2 and 7.1.
