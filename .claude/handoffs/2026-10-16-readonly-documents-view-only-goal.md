# /goal — READONLY gets view-only document access (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-16-readonly-documents-view-only-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§6) or a genuine external blocker. Loop until every Success Criterion (§5) is proven with evidence, then open the PR, queue it with mq, write a handoff and stop.`

## 1. Mission

PR #120 put READONLY, COLLECTIONS_OFFICER and INSURANCE_OFFICER in `STAFF_ROLES` (`lib/document-auth.ts`). Document access there is all-or-nothing, so READONLY can now:
- upload documents (KYC uploads included);
- run the biometric selfie capture;
- record a client's branch signature;
- trigger extraction, which for a bank statement re-reads it and recomputes the client's credit checks.

Narrow READONLY to **view and list only**. Every other role keeps exactly what it has after #120.

"Done" means:
- READONLY gets 403 on every document write route, with an audited refusal, and still views and lists documents with a `DocumentAccessLog` row.
- The UI hides the write controls from READONLY.
- Real-PG and unit tests are mutation-verified, and a browser check passes.

## 2. What already exists — do NOT redo

- **Precondition:** #120 must be merged into `main` before you start (`gh pr view 120 --json state`). If it isn't, wait. It was in the merge queue on 2026-10-16 07:30.
- **Start:**
  - `git fetch origin && git worktree add -b fix/readonly-documents-view-only ../CredaFlow-readonly-docs origin/main`
  - `cd` there, then `npm ci --legacy-peer-deps` and `npx prisma generate`.
  - Use Node 22 for the gates: `PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH`.
- **Caller resolution:** `getDocumentCaller()` in `lib/document-auth.ts` returns `{ type: "staff", role, ... }`. Since #120 it reads the stored user row (`active`, role), never only the session.
- **Routes that gate only on `getDocumentCaller`** (methods verified on the #120 branch):
  - Read, must stay open to READONLY:
    - `app/api/documents/[id]/view/route.ts` GET (writes the `DocumentAccessLog` view row)
    - `app/api/documents/[id]/route.ts` GET (metadata row)
    - `app/api/clients/[id]/documents/route.ts` GET
    - `app/api/clients/[id]/signing-packets/route.ts` GET
  - Write, READONLY must be refused:
    - `app/api/documents/route.ts` POST (upload)
    - `app/api/documents/selfie/route.ts` POST
    - `app/api/documents/[id]/sign/route.ts` POST
    - `app/api/documents/[id]/extract/route.ts` POST. Only `retryFailed` uses `hasMinRole(CREDIT_OFFICER)`; the route itself checks just `caller.type === "staff"`.
  - Already narrower, leave as they are:
    - `app/api/documents/[id]/route.ts` DELETE (SUPER_ADMIN)
    - `app/api/documents/generate/route.ts` (`requireApiRole("CREDIT_OFFICER")`)
- **Refusal auditing:** `lib/audit-refusals.ts`, and `withTenantContextLoggingRefusal` (`lib/documents/tenant-refusal.ts`) as used in the sign route. Reuse them; don't invent a new audit path.
- **UI:**
  - `components/documents/DocumentsTab.tsx` (Upload Document, sign, the preview's actions)
  - `components/clients/KycChecklistTab.tsx` (uploads, selfie, extraction)
  - Find the role the client page has. Do not pass it in from an untrusted source.
- **Existing tests to extend, not replace:**
  - `lib/document-auth.test.ts`
  - `app/api/documents/[id]/view/route.admin.integration.test.ts` (`RUN_DB_IT` pattern)
  - the per-route `route.test.ts` files beside each route
- **Test databases:** only through `scripts/it-db.sh up|check|down <unique-name>`, always torn down with `docker rm -fv`.
- **Merging:** only through `mq add <pr>`.

## 2a. Product decisions (already made — Hein, 2026-10-16)

1. **READONLY:** view + list only.
   - Refused: upload, selfie capture, branch signing, extraction.
   - Allowed: view, list, document metadata, signing-packet listing. Each read stays logged.
2. **COLLECTIONS_OFFICER and INSURANCE_OFFICER:** keep full access exactly as merged in #120. Do not narrow them.
3. **Every other role is unchanged.** CREDIT_OFFICER and up, ADMIN, BRANCH_MANAGER and COLLECTIONS_AGENT keep everything. Delete stays SUPER_ADMIN; generate stays CREDIT_OFFICER+. Operator roles stay out of `STAFF_ROLES`.
4. **A refused write returns 403** with a short, plain error (for example "Your role can view documents but not change them."), and an audited refusal row.

## 3. The change — what "real" means

**Recommended design** `[agent decides details]`:
- One helper beside `getDocumentCaller`, for example `canWriteDocuments(caller)` or a `DOCUMENT_READ_ONLY_ROLES = ["READONLY"]` set, used by the four write routes right after the caller resolves.
  - A client caller is unaffected: portal clients keep their own-document upload, sign and selfie paths exactly as today.
  - Define it once. No per-route role lists that can drift.
- Every write route: if the staff caller is read-only, write the refusal audit and return 403 **before** any body parse, DB write, file write or background job.
  - Extract must not reach `readStatementInBackground` or `recomputeClientApplications`.
  - Selfie must not start a capture attempt.
- **UI:** hide or disable Upload, sign, selfie and extraction controls for READONLY, with no dead buttons. If a control is disabled rather than hidden, add a short tooltip.
- **Sibling sweep:** grep for every other caller of `getDocumentCaller` and every route under `app/api/documents/` and `app/api/clients/[id]/` that writes a `ClientDocument`, `DocumentAccessLog`, extraction or selfie row. Any write route this list missed gets the same gate, with its own test.

**Tests (TDD, each must fail first):**
- **Unit, per write route:** a READONLY caller gets 403, the mutating Prisma call is never made, and a refusal is audited. COLLECTIONS_OFFICER and CREDIT_OFFICER still pass.
- **Unit, helper:** the role table, including CLIENT unaffected and every other staff role allowed.
- **Real-PG integration (`RUN_DB_IT`), extending the ADMIN suite or a sibling:**
  - a READONLY user can list and view a document, which writes the `staff`/`view` row;
  - their upload, sign and extract attempts are refused, and no `ClientDocument`, extraction or `DocumentAccessLog` mutation row appears beyond the refusal audit;
  - a COLLECTIONS_OFFICER can still upload.
- **Mutation evidence:** remove the gate from one write route and show its test going red. Put this in the PR.

## 4. Acceptance (browser)

- Build for production (`npm run build`, then `next start`) against a seeded throwaway DB (`npm run seed:base` with the `SEED_*_PASSWORD` env vars).
- Switch one seeded staff user to READONLY in that throwaway DB only, and sign in with their TOTP (`generateTotpCode` in `lib/totp.ts`, using the stored `totpSecret`).
- On a client's Documents tab and KYC tab:
  - no Upload, sign, selfie or extraction control is offered;
  - View PDF opens a document;
  - one `staff`/`view` row is written.
- `curl` the four write routes with that session's cookie and show 403 for each.
- Take a screenshot. Synthetic data only.

## 5. Success criteria (all with evidence)

1. READONLY is refused on every document write route: 403, an audited refusal, and no state change. The unit and real-PG tests prove it, and one is mutation-verified.
2. READONLY still lists and views documents with a `DocumentAccessLog` row (real PG and browser).
3. COLLECTIONS_OFFICER, INSURANCE_OFFICER and every other role behave exactly as before. Tests pin at least COLLECTIONS_OFFICER upload and CREDIT_OFFICER extract.
4. The UI shows READONLY no write controls (browser screenshot).
5. `npm run ci:quality` and `npm run ci:integration` are green.
6. A blind review (a fresh agent given only the diff and CLAUDE.md) and an adversarial breaker returned SHIP. The breaker asks: "can READONLY still change a document, a KYC record or a credit check by any route, or can a portal client lose an ability?" Its findings are fixed and it has reconfirmed.
7. The PR is opened, the evidence is in its body, and it is queued with `mq add`.

## 6. Confirmation gates (stop and ask Hein)

- Narrowing COLLECTIONS_OFFICER, INSURANCE_OFFICER or any other role, or widening anything.
- Changing what a portal CLIENT may do.
- Any migration. None should be needed.
- Touching the live demo, the Fairscore stack, their runners or crons, or the shared vLLM.
