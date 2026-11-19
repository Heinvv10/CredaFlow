# /goal — Lesotho PostBank tender: land wave 1, run wave 2, then the shortfall email (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-29-lpb-tender-continue-goal.md to completion. Act as coordinator: finish every open PR through blind review + breaker rounds, merge via mq, then dispatch wave 2 and tier B, and draft the Fair Score email. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then write a handoff and stop.`

Read first: `.claude/handoffs/2026-10-29-lpb-tender-plan.md` (tiers, waves, conflict rules, a running log of every decision). This goal file is the action list; the plan file is the history.

---

## 1. Mission

CredaFlow is bidding on Lesotho PostBank's LMS tender (LPB/0009/2026) as a JV with Fair Score (51%). **Bid closes 25 Nov 2026 12:00 CAT; clarification questions close 12 Nov 16:30 CAT.** The technical evaluation is pass/fail per spec line, "Comply" needs evidence, and a live demo can be demanded. The job: land the six wave-1 PRs, build wave 2 (A5, A6, A3, A10) and tier B, then write the shortfall email to Pramod and Dr Danny (Fair Score). "Built" = real DB, real API, RBAC, audit, tests that fail when the code is wrong, a blind review + breaker that both say SHIP, merged through `mq`, and UI work shown in a real browser with screenshots.

You are the **coordinator**: you do not write feature code yourself. You dispatch builder agents (`coder-hard`, sonnet) in their own worktrees, and run blind reviewers per `/review` / `review-team` (quality + security + TDD on sonnet, architecture + breaker on opus). Reviewers never see builders' reasoning.

## 2. State at hand-off (2026-10-29 ~18:15 SAST) — do NOT redo

**The previous session's builder agents may still be running** (Hein said don't stop them). They were in-process subagents of that session and probably die when it closes, but their **worktrees and pushed branches persist**. Before dispatching anything, for each row below:
`git -C <worktree> status --porcelain` (uncommitted work?), `git -C <worktree> log --oneline -3`, `git log origin/<branch> -1`, and `gh pr view <n> --json headRefOid,mergeStateStatus`. If a worktree has fresh uncommitted work (< 30 min old) a live agent may still own it: wait 30 min before touching it. Otherwise dispatch a fresh builder into that worktree with the "Open items" as its brief.

| PR | Item | Branch / head | Worktree | Status | Open items |
|---|---|---|---|---|---|
| #252 | A9 Helm, CI scans, observability | `feat/lpb-a9-platform` @ `03be993d` | `CredaFlow-lpb-a9` | **APPROVED + CI green; QUEUED in mq 18:22** | Check `mq status` / `gh pr view 252`; if merged, remove worktree `CredaFlow-lpb-a9` (unless the F2 agent is using it — F2 has its own `CredaFlow-lpb-f2`). If ejected, read `mq log` and fix. |
| #254 | A7 SSO (OIDC/SAML), OAuth2, mTLS, API IP allowlists | `feat/lpb-a7-sso-oauth` @ `7a6a1371` | `CredaFlow-lpb-a7` | **APPROVED + CI green; QUEUED in mq 18:22** | Check `mq status`; if ejected, read `mq log`. If merged, remove worktree `CredaFlow-lpb-a7`. Follow-up docs PR: `docs/SSO-AND-OAUTH.md` lines ~78–79 (bound users have no password path while SSO is on; disabling SSO is the outage recovery). |
| #258 | Self-hosted CI runners | `ci/self-hosted-runner` @ `9cc35cd4` | `CredaFlow-ci-runner` | **Security fixes + scope pushed at 9cc35cd4**; CI run 40908537738 was in progress at hand-off | Done: sudo apt steps replaced by fail-clearly tool checks; random masked PG password, 0700 dirs; fork guard on every self-hosted job; `integration` aggregate on ubuntu-latest. Accepted: TCP 127.0.0.1 (run-integration-tests.sh refuses `host=` URLs) and SUPERUSER test role (7 suites use `session_replication_role`). Optional: move the 9 s `quality` summary job to ubuntu-latest. Next: confirm run green → blind review (workflow + pg-cluster.sh) → `mq add 258`. |
| #253 | A1 Lesotho jurisdiction | `feat/lpb-a1-jurisdiction` @ `97e4c016` | `CredaFlow-lpb-a1` | Round 3: **redesign requested** | Single-row `InstanceJurisdiction` table (immutable once loans exist); all tenants must match it (advisory-locked triggers on Tenant/TenantConfig, incl. PROVISIONING); app reads it with ~60 s TTL re-check, fails closed on mismatch; 409 pre-checks vs that row; operator can provision LS lenders on an LS instance; refuse staff sign-in for non-ACTIVE tenants; tenant deletion blocked once loans exist = **accepted**; run the FULL integration gate. Then round 4 (fix review + breaker `afde3360…`-style attack on races/warm process). |
| #255 | A2 IFRS 9 | `feat/lpb-a2-ifrs9` @ `0f61144e` | `CredaFlow-lpb-a2` | Round 2 fixes requested | Backdated runs use the month-end book (`lib/reports/book-as-of.ts`); NET_BASIS re-implemented per IFRS 9 5.4.1(b) (Dr INTEREST_INCOME / Cr ECL_EXPENSE for Stage-3 interest × ECL/gross, no suspense, nothing restored on cure) **or removed**; late run for M refused while M+1 has a run; refuse moving `effectiveFromMonth` forward with a posted position; disable guard checks INTEREST_SUSPENSE; RESTRUCTURED marker survives Stage 3; DESIGN.md honest; P2002 → 409. Breaker repros: `/tmp/claude-1003/-home-hein-Workspace-CredaFlow/11ba63b8-93d1-4f4e-8fbf-722224d9e1b5/scratchpad/brk255b*.ts` (may be gone — recreate from the PR comments). **Then build Reports → IFRS 9 page** with browser screenshots (follow-up F6). |
| #256 | A4 rules engine + maker-checker | `feat/lpb-a4-rules-engine` @ `54c60941` | `CredaFlow-lpb-a4` | Round 2 fixes requested | Reopen only the engine's own decline + `humanReviewRequestedAt` marker so the engine never re-decides; s71 notice only for system-made declines, wording version stored on the run, also via WhatsApp; SHADOW side-effect free (no status move, no paid bureau pull); SoD: when approver is the system user, disburser ≠ capturer ≠ reckless-lending attester; durable digital trigger (due row + sweep cron); hide/refuse edits to the system user, CHECK role; `payloadVersion` allowed in the guard trigger; `guardDecisionEngineConfig` compares mode/s71 signer against the request; rate-limit portal-triggered bureau pulls. |
| #257 | A8 tamper-evident audit + SIEM | `feat/lpb-a8-audit-siem` @ `1ce03f0b` (check — redesign may be in progress) | `CredaFlow-lpb-a8` | **Redesign requested — must NOT merge as built** | Lock-free AuditLog inserts + async chainer writing insert-only `AuditChainLink`; HMAC (`AUDIT_CHAIN_KEY`) + daily signed checkpoints forwarded to SIEM; verifier detects rollback/wipe vs last checkpoint; PII columns hashed as digests (audited redaction possible); SIEM per-action field allowlist with masking; policy change sent to the OLD destination; test-connection endpoint TOTP-gated, rate-limited, audited, coarse errors; RLS on new tables; two DB logins (owner for migrations, non-owner app login with INSERT/SELECT only on AuditLog, no rights on link/checkpoint/outbox — chainer/delivery via SECURITY DEFINER functions owned by an audit role); test coverage per hashed column; security events asserted. ITs: Serializable vs autocommit (no 40001), `skipDuplicates`, opposite-order lock (no deadlock). After it merges, #253/#254/#256 IT teardowns must use `lib/audit/audit-rows.test-helpers.ts`. |
| (none yet) | F1 secret-box GCM tag + F2 shared Postgres rate-limit store | `feat/lpb-f2-shared-rate-limit` (not pushed yet) | `CredaFlow-lpb-f2` | Dispatched to the A9 agent just before hand-off | F1: `authTagLength: 16` in `lib/crypto/secret-box.ts` openSecret + truncated-tag test. F2: Postgres-backed store behind `checkRateLimit` (atomic upsert-increment, TTL cron, fall back to memory on DB error, IT with two Prisma clients). |

**Merge order:** #258 (CI) → #252 → #254 → #253 → #255 → #256 → #257. Each later PR rebases on main; after #257, the others' integration teardowns switch to the audit purge helper. Merge only via `mq add <pr>` (worker `merge-queue.service`; agents' `gh pr merge` is hook-blocked; mark ready before push).

## 2a. Product decisions already made (do not re-ask)

- JV bid as CredaFlow + Fair Score (51%). Fair Score brings ISO 27001, LMS references and certified staff.
- Ndzinga Capital (live, NCR-registered) is the spec 1.2 "live at a regulated institution" reference; CredaFlow is the white-label of that codebase.
- One lender per instance. Jurisdiction is per instance (ZA | LS). South African NCA protections and **ZA NCA PDF output must stay byte-identical** (the pinned hash tests must stay green without re-pinning; ZA negative amounts in PDFs keep "R -0.05").
- Never invent Lesotho legal wording. LS documents come from lender-owned versioned templates (A10), marked SAMPLE in demos.
- The staff-TOTP rule in CLAUDE.md stays as written: `trustIdpMfa` was removed; SSO users enrol CredaFlow TOTP when the lender requires it.
- Automated decisions are booked under a per-lender inactive non-login system user. The engine REFERs instead of DECLINE until the lender records a POPIA s71 sign-off; the automated-decline notice text is lender-supplied only.
- IFRS 9: per-lender Stage-3 basis: FULL_SUSPENSION (Central Bank / tender 2.8.3) or a correct NET_BASIS (IFRS 9 5.4.1(b)). Bank supplies PD/LGD and probation months.
- Audit chain: async chainer design (§2 row #257).
- CI: heavy jobs on our own self-hosted runners (`[self-hosted, linux, velo, credaflow]`, user `gha-credaflow`, no sudo, no docker); light and Docker jobs on GitHub-hosted. GitHub billing is fixed. Two runners for now; machine load is high (55–70 on 32 cores).
- Lenders are retired by status, never deleted.
- Hein: "no live clients — merge and deploy as needed" (CredaFlow only). He set today's prod-deploy override; for later days ask him to run `! date +%F > ~/.claude/prod-deploy-override` if `critical-guard.py` blocks a deploy.
- Fair Score email: draft **after** the build (Hein: "build first, then draft the mail again"), unless the build runs past ~5 Nov, in which case flag a short early version (clarifications close 12 Nov). Hein sends it; never send it yourself.

## 3. Wave 2 (dispatch after #256 merges; A3 after A5)

Briefs follow the wave-1 pattern (see the plan file's "Conflict rules"): own worktree `/home/hein/Workspace/CredaFlow-lpb-<id>`, branch from `origin/main`, new schema in its own `prisma/schema/*.prisma` file, registries as files, TDD, gates (`npx tsc --noEmit`, `npm run lint`, full `npm test`, `npm run ci:quick`, `RUN_*_IT` on `scripts/it-db.sh` with a unique container name + `docker rm -fv`), ready PR, no merge.

- **A5 Product engine** (spec 2.1.1–2.1.4, 2.6.1): weekly/fortnightly frequencies, grace periods, bullet and interest-only, product versions with effective dates through the A4 maker-checker (`lib/maker-checker/`, handlers as `lib/registry/change-handlers/` files, `baseRef`), pricing by risk grade (`getRiskGrade`, compare by `rank`), segment and channel. ZA NCA documents unchanged. Loan maths needs hand-worked tests that fail first.
- **A6 Approval matrix** (2.4.1, 2.4.2, 2.2.6): multi-level approval by amount/product/risk/branch, delegated authority, TAT escalation, credit committee packs and decisions; matrix changes through maker-checker with per-payload `approvePermission`.
- **A3 Restructure / top-up / refinance / consolidation / payment holiday** (2.6.6) with approval and full history (after A5).
- **A10 LS documents + approval path** (2.2.4, 2.4.3, after #253): persist a non-NCA regime on application/loan so DB rules branch on it; signing/disbursement gate for LS requires an approved key facts statement + loan agreement rendered from lender-owned versioned `DocumentTemplate`, SAMPLE-marked in demos; extend operator provisioning for LS.
- **F7** (after #253 + #256): for non-NCA lenders, allow an automated affordability attestation so spec 2.3.9 instant digital approval can actually approve (today it always refers because portal apps lack the reckless-lending attestation; correct for ZA).
- **F3** sweep the ~17–26 remaining hardcoded rand formatters (after wave 2, conflict avoidance).
- **F4** IFRS 9 PD/LGD/settings changes through maker-checker (after #255 + #256).
- **F5** move `decide-application.ts` to `lib/applications/decide.ts` with a typed result (low priority).

## 4. Tier B (if time, after wave 2)

Tokenization + separate token vault (4.2/4.3), report builder + CSV/PDF export (2.8.4), roll/cure/PTP/productivity reports + early warning (2.7.2, 2.7.10), payroll check-off file import (2.6.3), a mobile-money adapter, AI-drafted credit memos for staff review (2.9.3), a live PEP/sanctions provider (2.2.2).

## 5. Tier C (do NOT build; mark partial in the compliance sheet with a dated roadmap)

Drag-and-drop process designer (2.9.5), full microservice split (5.2), HSM (4.4). Prepare clarification questions for the bank (due 12 Nov): is a modular monolith with containers equivalent to 5.2; Lesotho national ID card format; Central Bank of Lesotho report layouts; Lesotho Sunday-holiday observance.

## 6. Demo

After wave 1 merges, deploy to the demo stacks (Tsela / Fair Score, see memory `project_credaflow_demo_simulator.md`) and seed a Lesotho demo lender (`DEMO_LENDER=basotho`) on its own instance. `SSO_SECRET_KEY` must be added to existing env files before an image with #254 runs. Bake after hours (shared vLLM). Browser-check every tender feature on the demo with screenshots; these become compliance-sheet evidence.

## 7. Final deliverables

1. **Compliance summary:** every Section 6 line (1.1–7.3), shown as Comply / Partial / Not comply, with evidence (PR, screenshot, doc) and a note on what the partner (Fair Score) supplies (ISO 27001, PCI QSA matrix, pen test, 3 LMS references, PM/integration/security lead CVs). Publish it as an artifact.
2. **Email draft to Pramod and Dr Danny:** shortfalls, what Fair Score must supply and by when, the JV paperwork list, the performance guarantee, whether the tender pack was bought in the bidder's name (clause 6.3), and the clarification questions. The first draft is at `/tmp/claude-1003/-home-hein-Workspace-CredaFlow/11ba63b8-93d1-4f4e-8fbf-722224d9e1b5/scratchpad/email-fairscore-lpb-draft1.md` (may be gone). Update it with what was actually built. Draft only.

## 8. Success criteria

- [ ] #258, #252, #254, #253, #255, #256, #257 merged to main via `mq`, each with a final blind review and a breaker (where applicable) saying SHIP on the merged head, findings posted as PR comments.
- [ ] A5, A6, A3, A10 merged the same way; F1–F4 and F7 merged or explicitly deferred with a reason.
- [ ] Every DB-enforced rule has a `RUN_*_IT` test, mutation-proven.
- [ ] ZA NCA fingerprint tests unchanged throughout.
- [ ] A Lesotho demo lender shows end-to-end in a browser, with screenshots: application → automated decision → approval → signing with LS templates → disbursement → IFRS 9 staging. A ZA demo is still unchanged.
- [ ] Compliance summary artifact published; email draft ready for Hein.
- [ ] Plan file status log and `.claude/handoffs/LATEST.md` updated; worktrees removed after merge.

## 9. Confirmation gates (stop and ask Hein)

- Spending money: QSA engagement for the PCI responsibility matrix, independent pen test, a third CI runner on paid hardware, any paid API.
- Sending the Fair Score email or anything to the bank.
- Changing NCA-mandated wording or re-pinning NCA render hashes.
- Changing the staff-TOTP rule in CLAUDE.md, or any compliance rule's text.
- Production deploys of real lenders (none exist); demo deploys are pre-approved.
- Anything a breaker shows weakens a ZA NCA protection that you can't fix.
