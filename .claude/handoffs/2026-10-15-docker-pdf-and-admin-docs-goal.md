# /goal — Two pre-existing bugs: PDF generation in the Docker image + ADMIN document access (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-15-docker-pdf-and-admin-docs-goal.md to completion. Work autonomously through Reproduce → Fix (TDD) → Verify → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§6) or a genuine external blocker. Loop until every Success Criterion (§5) is proven with evidence, then open the PR, queue it with mq, write a handoff and stop.`

## 1. Mission

Fix two bugs that are on `main` today. PR #114's browser check found both; it did not cause them.

- **A. Docker PDF generation:** in the production image, every `htmlToPdf` call fails, so no custom-template PDF can be generated in any containerised deployment.
- **B. ADMIN document access:** a user with role `ADMIN` gets 401 from every document route. That covers view, list, generate and sign; credit officers and super admins work.

"Done" means:
- Each bug has a test that fails on today's `main` and passes after the fix (mutation-verified).
- The Docker fix is proven by generating a real PDF inside a locally built image.
- The ADMIN fix is proven by an ADMIN viewing a document in a browser against a seeded local DB, with a `DocumentAccessLog` row written.
- Nothing else changes.

## 2. What already exists — do NOT redo

- `main` is at `9165dbde` (PR #114 merged): next 16.4.1, puppeteer 25.14.0, sharp 0.35.5, nodemailer 10.1.1, Node `>=22.12.0`.
- Start: `git fetch origin && git worktree add -b fix/docker-pdf-and-admin-docs ../CredaFlow-pdfadmin origin/main`, then `cd` there and `npm ci --legacy-peer-deps`. Install in the worktree; otherwise Node resolves the parent's `node_modules`.
- Use Node 22 for the gates: `PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH`. The machine default is 20.20.
- Gates: `npm run ci:quality`, `npm run ci:integration` (or `ci:full`), `npm run claude-md:check && npm run agents:check` if any `.claude.md` is touched.
- Test DBs only via `scripts/it-db.sh up|check|down <unique-name>`, and always tear down (`docker rm -fv`).
- Merge only through the queue: `mq add <pr>`. Agents cannot `gh pr merge`.
- Handoff with the full background: `.claude/handoffs/2026-10-15-dependency-security-upgrades.md`.

### 2a. Product decisions (already made by Hein, 2026-10-15)

- **ADMIN gets the same client-document access as other staff:** view, list, upload, generate, extract and sign, exactly as CREDIT_OFFICER/LOAN_ADMIN/SUPER_ADMIN have today. Access stays logged through `lib/document-auth.ts` → `DocumentAccessLog` (POPIA).
- Do not widen anything else: no new roles, no change to client/portal access or to tenant scoping.

## 3. Bug A — Chromium cannot start in the production image

**Root cause (verified 2026-10-15 in PR #114's session):**
- The runner stage of `Dockerfile` creates `nextjs` with `useradd --system --uid 1001 --gid nodejs nextjs` (line ~72). That user gets `HOME=/home/nextjs`, but no home directory is created.
- Debian's `chromium` (installed in the runner stage) then dies at launch with `chrome_crashpad_handler: --database is required`.
- `puppeteer` 24.40 and 25.14 both fail identically inside the image, and both launch fine with a writable `HOME`, e.g. `docker run -e HOME=/tmp ...`.
- Observed through the UI as "Failed to generate document". The container log shows `Failed to launch the browser process`.

**Reproduce first:** `docker build -t <unique-tag> .` from a clean tree, then in a container:
```
docker run --rm --entrypoint node <tag> -e 'import("puppeteer").then(async ({default:p})=>{const b=await p.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"],executablePath:"/usr/bin/chromium"});console.log(await b.version());await b.close()})'
```
It should fail on `main`.

**Fix `[agent decides]`:** the minimal Dockerfile change that gives `nextjs` a real, writable home. Two options:
- `useradd --system --create-home --uid 1001 --gid nodejs nextjs` (preferred: HOME stays truthful).
- An explicit `ENV HOME=/tmp`-style override.

Do not add `--disable-crash-reporter` or other Chromium flags as the fix. They paper over the missing home, and other tools also write there.

**Check the siblings:** grep the compose files and `scripts/demo/`, `scripts/lender/` for other images or `user:` overrides that would hit the same thing, e.g. a `docker-compose*.yml` that sets `user:` or `HOME`. Fix any sibling in the same PR, or record why it doesn't apply.

**Test (must go RED on main):** add an opt-in real-docker integration test modelled on `scripts/lender/build-context.integration.test.ts`. That file is gated behind `RUN_DOCKER_BUILD_IT=1` and NOT run by the CI integration job, because a full image build runs it out of memory.
- Build the image, then run `htmlToPdf` (or a puppeteer launch + `page.pdf`) inside it as the image's own user.
- Assert a `%PDF-` buffer comes back.
- Use a unique image tag and remove it in `afterAll`.
- Prove RED by running it against an image built from `main`'s Dockerfile.
- Keep it opt-in under the existing `RUN_DOCKER_BUILD_IT` variable. Don't add a new gated variable to the CI runner.
- Check whether `scripts/__tests__/run-integration-tests-opt-in.test.ts` must list the new file.

## 4. Bug B — ADMIN refused by document auth

**Root cause:** `lib/document-auth.ts:6-12` hard-codes `STAFF_ROLES` as SUPER_ADMIN, CREDIT_OFFICER, LOAN_ADMIN, COLLECTIONS_AGENT and BRANCH_MANAGER. ADMIN is missing.
- An ADMIN session falls through to the portal-client lookup and `getDocumentCaller()` returns `null`.
- Every document route then answers 401 and audits `DOCUMENT_ACCESS_REFUSED` with reason `caller_not_resolvable_in_tenant`.
- Observed: `/api/documents/[id]/view` returned 401 for the seeded `admin@acme-lending.example`. The client page's Documents tab showed "No documents uploaded yet" for a client with 2 documents, because the list call was refused the same way.

**The list is also out of step with the rest of the app.** `lib/permissions.ts` and `lib/auth-guards.ts` (`ROLE_HIERARCHY`) also include READONLY, COLLECTIONS_OFFICER and INSURANCE_OFFICER. Per §2a, add **ADMIN only**. Do NOT silently add READONLY / COLLECTIONS_OFFICER / INSURANCE_OFFICER; they are a separate access decision. List them in the PR body as "not changed, needs a decision".

`[agent decides]` whether to keep a local list or derive it from an existing shared role list. Derive only if the derived set is exactly today's set plus ADMIN. Simplicity first.

**Callers to check** (all use `getDocumentCaller`; use `git grep -n getDocumentCaller` for the full list):
- `app/api/documents/[id]/view/route.ts`, `app/api/documents/[id]/route.ts`, `.../extract/route.ts`, `.../sign/route.ts`, `app/api/documents/route.ts`, `app/api/documents/selfie/route.ts`
- `app/api/clients/[id]/documents/route.ts`, `app/api/clients/[id]/signing-packets/route.ts`

Some routes may layer their own role gates on top. Read each one so ADMIN gets exactly what LOAN_ADMIN/CREDIT_OFFICER get there.

**Tests (must go RED on main):**
1. A unit test in `lib/` (next to `document-auth.ts`, or in its existing test if there is one) proving `getDocumentCaller()` returns `{ type: "staff", role: "ADMIN" }` for an ADMIN session. Mutation: drop ADMIN from the list and watch it go red.
2. A real-PG integration test (gate it with an existing or new `RUN_*_IT` variable that `scripts/run-integration-tests.sh` exports; read how it discovers variables) proving:
   - an ADMIN in tenant A gets 200 on `GET /api/documents/[id]/view` for a tenant-A document, and a `DocumentAccessLog` row (`accessorType: "staff"`, `action: "view"`) is written;
   - an ADMIN in tenant B is still refused that tenant-A document (403 or 404 as today for cross-tenant staff), and the refusal is audited.
   Existing cross-tenant suites to copy patterns from: `app/api/documents/[id]/view/route.cross-tenant.test.ts`, `app/api/documents/cross-tenant-refusal.test.ts`.
3. Existing document suites stay green.

## 5. Success criteria

1. Bug A:
   - The opt-in docker test fails against an image from `main` and passes with the fix (show both outputs).
   - A locally built image boots, `/api/health` returns 200, and a custom template generates a PDF through the UI ("Document generated") with no `HOME` override in `docker run`.
   - Siblings checked.
2. Bug B:
   - The unit test and the integration test both fail on `main` and pass after the fix (mutation-verified).
   - In a browser against a seeded local DB (`SEED_PRINT_CREDENTIALS=1` with `SEED_*_PASSWORD` set; staff sign-in needs the printed TOTP secret), `admin@acme-lending.example`:
     - sees the client's documents listed in the Documents tab;
     - opens one via `/api/documents/[id]/view`;
     - leaves a `DocumentAccessLog` view row.
   - Take a screenshot.
3. `ci:full` is green on Node 22, and the NCA fingerprint (`npx tsx scripts/nca-pdf-fingerprint.ts "$PWD"`) is unchanged.
4. The blind `/review` and a blind security review both return SHIP, and all findings are fixed. The security reviewer must look specifically at whether adding ADMIN widens anything beyond §2a.
5. One PR opened and queued with `mq add`, a handoff written, and the memory file `project_credaflow_dep_upgrades.md` updated: the two open items are resolved.

## 6. Confirmation gates (stop and ask Hein)

- Any change to which roles other than ADMIN can access documents.
- Any change to the client/portal document path or to tenant scoping.
- Anything touching the demo, Fairscore or production stacks: no rebuilds or restarts. Note in the handoff that the demo images need a rebuild to pick up the Dockerfile fix.
- Any Chromium flag change beyond the HOME fix.
