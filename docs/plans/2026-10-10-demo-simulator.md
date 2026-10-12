# Demo simulator — plan (2026-10-10)

## Goal

`demo.credaflow.com` shows a tenant ("Acme Lending") with six months of
realistic activity behind every screen, report and NCA document, plus three
live-demo personas whose specimen documents can be uploaded during a demo to
run the full origination path: application → credit bureau → document
extraction/validation → selfie/ID check → affordability → approval → PASQ →
agreement signing → debit mandate → countersign → disbursement.

## Design concept

**A simulator, not a seed.** Data is produced by driving the real HTTP API as
staff and borrowers under a controlled clock, never by inserting rows. The
schema enforces ~150 trigger/CHECK invariants (PASQ hashes, signed mandates,
payment reconciliation, document hash binding); inserted rows would either be
rejected or look valid while being wrong, and the NCA PDFs would never be
generated.

**Bake once, restore often.** The simulation is slow (minutes), so it runs in a
separate stack and the result is snapshotted (`pg_dump` + uploads tarball).
Restoring the snapshot into the live demo stack takes seconds and runs nightly
and on demand before a demo. Restore resets personas to unused.

## Decisions (Hein, 2026-10-09/10)

- Live demo = the whole origination path (bureau, doc validation, selfie
  included). Background = every lifecycle state.
- Reset = one restore command + nightly restore.
- Bureau and selfie run simulated (`*_DRY_RUN`); document extraction runs on
  the real VLM on velo-server (`:8100`, Qwen3-VL).

## Proven

- `libfaketime` with a timestamp file moves the clock of a running Node 22
  (alpine) process and a running Postgres 16 (alpine) backend — spike
  2026-10-10. Both app and DB run under the same faked clock, so DB-stamped
  `CURRENT_TIMESTAMP` values agree with app-supplied ones.

## Risks

- **History ages.** A snapshot baked on day D shows loans as they stood on D;
  restored weeks later, DPD and arrears drift. Mitigation: re-bake monthly (first Sunday, throttled to one VLM request at a time — a weekly unthrottled bake made the shared vLLM's health check restart it, 2026-10-10)
  (scheduled), restore nightly from the latest bake.
- **Route handlers carry the logic** (disburse 1940 lines, agreement 1625).
  Driving them over HTTP is the point; it also means a broken route breaks the
  bake — which is a feature (the demo can't silently rot).
- **Specimen identity documents.** Every generated ID/payslip/statement is
  watermarked SPECIMEN, uses fictional people and employers, and ID numbers
  that pass the Luhn check but carry an obviously synthetic pattern.
- **VLM is shared** with FibreFlow production. Bake-time extraction load is a
  few dozen documents; acceptable.

## Module shape

```
scripts/demo/
  sim/clock.ts          write the faketime file; advance to a date
  sim/api.ts            HTTP client: staff login (password + TOTP), portal login, cookie jar
  sim/cron.ts           hit /api/cron/* with CRON_SECRET for a simulated day
  personas/*.ts         fictional people (valid SA ID, employer, salary, bank)
  specimens/*.ts        SPECIMEN ID card PNG, payslip PDF, bank statement PDF per persona
  scenarios/*.ts        storylines: persona + target end state + dated actions
  simulate.ts           orchestrator: steps days, runs scenarios + crons
  bake.sh               sim stack up → migrate → base seed → simulate → snapshot
  restore.sh            snapshot → live demo DB + uploads volume → restart app
docker-compose.demo-sim.yml   db + app under faketime, no public ingress
~/credaflow-demo-data/kits/<as-of>/<persona>/   (outside git; kits/build.ts)
                        the files to upload live + a one-page cheat sheet
```

App change (small, product code): `DEMO_MODE=true` renders a persistent
"Demo — not a real lender" banner and `noindex`.

## Task DAG

| # | Task | Depends | Verify |
|---|------|---------|--------|
| T1 | Sim stack + clock + API client (staff+TOTP, portal login) | — | script logs in as admin and as a client under a faked date; `/api/health` + an authenticated GET return 200 |
| T2 | Personas + specimen generator | — | VLM extracts name, ID number, employer, net pay from each generated doc and they match the persona |
| T3 | Origination scenario: one persona API-driven to DISBURSED | T1, T2 | loan exists; PASQ, agreement, executed agreement, mandate docs stored with valid SHA-256; no non-2xx on success steps |
| T4 | Servicing: receipts, bank-sync CSV, day-stepped crons, arrears, S129, payment plan, settlement, write-off | T3 | each target state reached; `assert_payment_allocation_reconciles` holds |
| T5 | Breadth: CRM, insurance, complaints, DSAR, bureau submissions, referral agents | T3 | each module's list page non-empty, no 500s |
| T6 | Bake + restore + nightly restore / monthly bake | T4 | restore < 60 s; app healthy after restore; a failed restore leaves the previous data live |
| T7 | DEMO_MODE banner + noindex; VLM wired into demo env | — | banner visible on both hosts; `X-Robots-Tag`/meta noindex present |
| T8 | Live-demo kits (3 personas) + dress rehearsal on localhost | T2, T6 | each persona runs the full origination path after a restore |

## Not building

- A restore button in the app (command only).
- Real bureau/KYC vendor sandboxes.
- Any change to NCA document templates.

## Review

Each task reviewed blind (`/review`) before merge to `demo/simulator`. The
demo is prospect-visible, so the branch keeps a human gate before it reaches
`main`.

## Product findings from the bake (2026-10-10)

Security (fix before any real client). All four are fixed on `feat/face-comparison-model` (c225f95), the base of this branch:
- **Selfie face match passes without a real face on the ID.** `lib/vlm-extract.ts` selfie prompt scored 0.85 PASS for a selfie against a card with a grey silhouette placeholder and against a cartoon face (3/3 runs); a blank card fails. KYC bypass risk. Two different real faces not yet tested. *Fixed:* face-match evidence v3 (`lib/kyc/selfie-biometric.server.ts`): both sides are reduced to one canonical image, a face model (YuNet + SFace, `lib/kyc/face-model/`) decides same-person, and the VLM's gates (the ID portrait must be a real photograph, liveness, its own match verdict) can only refuse.
- `POST /api/settings/users` has no role ceiling: a BRANCH_MANAGER or LOAN_ADMIN can create a SUPER_ADMIN. *Fixed:* staff-user writes have a role ceiling (nobody assigns or edits a role above their own) and need a TOTP-verified sign-in.
- `BreachLog` has no `tenantId`; list/edit routes work across tenants. *Fixed:* the breach log belongs to a tenant, its input is validated, its status moves are OPEN → CONTAINED or RESOLVED and CONTAINED → RESOLVED, and its writes are audited.
- Complaint and DSAR creation don't check the `clientId` belongs to the caller's tenant; no audit rows for complaint/DSAR/breach/branch writes. *Fixed:* complaints, DSARs and branches check foreign ids against the tenant and audit every write; a branch manager must hold a branch-manager role.

Functional:
- Lead conversion 500s on CHECK `LoanApplication_acknowledgement_requires_pasq_document`. *Fixed* on the base; the bake converts leads L07–L09 into a client and a submitted application through `POST /api/crm/leads/[id]/convert`.
- No path creates a platform operator (SUPER_ADMIN): the role ceiling now refuses one from Settings → Users, the seed creates only ADMIN and CREDIT_OFFICER, and `/api/admin/tenants` needs a SUPER_ADMIN to begin with. The CRM and bureau-submission modules can only be switched on by one.
- Payment arrangement marked BROKEN at 06:00 on its first due date, before a same-day payment can land.
- ADMIN (and INSURANCE_OFFICER, READONLY) can't view client documents (`lib/document-auth.ts`).
- No tenant-facing setting for `defaultChargesEnabled`, CRM or bureau submission; `featureCrm` change not audited.
- Website contact/apply leads get no Contact, so the CRM message drawer 400s for them.
- Scheduling a callback forces a lead back to CONTACTED.
- Bureau score floor default (450) is "not calibrated" and blocks every approval until a tenant sets one.
- `bankSyncEnabled` had no setting (added on this branch: Settings → Bank Statement Import).
- `/app/uploads` was root-owned in the image (fixed on this branch in `Dockerfile`).
- FAIS disclosure tokens are signed with `NEXTAUTH_SECRET`, not `AUTH_SECRET`; a deployment with only `AUTH_SECRET` 500s on standalone insurance sales.
- Agreement generation can overrun Prisma's 5 s interactive-transaction limit on a loaded host (the route cleans up and reports `agreementIntegrity: staging_failed`); the simulator retries once.
- `ClientOtp` has no `tenantId` and no `purpose`: fix before any shared-database phase.

## Dress rehearsal findings (2026-10-10, build 0c362f0)

All three live personas ran end to end through the real UI (headless Chromium, fake camera). Product bugs found:
- **Portal signing packet 404 (blocker):** `lib/proxy/shared-client-api.ts` does not allow `/api/applications/[id]/signing-packet` on the client host, so the borrower signs a packet they cannot view or download. *Fixed* on the base: the client host admits it for GET only.
- A DECLINED application's decision rail reads "Approved … Repayment method missing".
- Portal sign-in "Are you staff?" links to `/login` on the client host (404).
- Debit-mandate bank is never pre-selected (client stores the code, dropdown holds names).
- Returning client re-upload: new uploads show SUPERSEDED while old ones stay VERIFIED; "no selfie is needed" beside a REQUIRED selfie row.
- KYC status pill stays PENDING until refresh after 4/4 documents verified.
- No toast on "Update Affordability" and "Confirm Assessment Checks".
- Pending mandate has no action on the portal Applications card.
- Portal Apply advertises a micro loan "up to R 6,900.00" while the product maximum is R2 000.
