# Handoff — Docker PDF + ADMIN document access (2026-10-15)

Goal: `.claude/handoffs/2026-10-15-docker-pdf-and-admin-docs-goal.md`. PR **#116**
(`fix/docker-pdf-and-admin-docs`, worktree `../CredaFlow-pdfadmin`), one commit on top of
`origin/main` f172c105. Queued with `mq add 116`.

## What changed
- `Dockerfile`: `useradd --system --create-home ...`. The `nextjs` user now has a real
  `/home/nextjs`. Before this, chromium died with `chrome_crashpad_handler: --database is required`.
  No Chromium flags changed.
- `lib/document-auth.ts`: `ADMIN` added to `STAFF_ROLES`. Kept as a local list: today's set plus
  ADMIN is not a slice of `ROLE_HIERARCHY`, because INSURANCE_OFFICER sits between the roles.
- Tests:
  - `lib/document-auth.test.ts`: ADMIN resolves as staff.
  - `app/api/documents/[id]/view/route.admin.integration.test.ts` (`RUN_DB_IT`): list 200, view 200
    with a `DocumentAccessLog` view row, and a cross-tenant ADMIN refused with 403 and both
    refusal rows audited.
  - `lib/documents/html-to-pdf.image.integration.test.ts` (opt-in, `RUN_DOCKER_BUILD_IT`): builds
    the image and renders a PDF inside it as its own user.
  - `scripts/__tests__/run-integration-tests-opt-in.test.ts` now lists both opt-in suites.

## Evidence
- Each new test went RED on main and GREEN after the fix:
  - unit: `expected null`;
  - IT: 401 ×3;
  - docker: crashpad launch failure.
- In-image proof: an image built from the fix, run with no `HOME` override, returned 200 from
  `/api/health`. The custom template "Synthetic Letter" then generated through the UI ("Document
  generated"), and the served file was `application/pdf` starting with `%PDF-`.
- ADMIN browser proof against a seeded DB on the dev server:
  - the Documents tab lists both synthetic documents;
  - View PDF opens one;
  - `DocumentAccessLog` holds `staff`/`view` rows for `admin@acme-lending.example`.
- Screenshots are in the session scratchpad, which does not persist.
- `ci:quality` and `ci:integration` are green on Node 22. The NCA fingerprint is identical to
  origin/main.
- The blind code review and the blind security review both returned SHIP.

## Siblings
- `Dockerfile.demo-sim` is built FROM the product image, so it inherits the fix.
- `scripts/demo/sim/seed-faked.sh` and `smtp-sink.sh` already pass `-e HOME=/tmp` with a host uid
  and launch no chromium.
- No compose file sets `user:` or `HOME` for the app.

## Open
- **The demo (Acme) and Fairscore images need a rebuild to pick up the Dockerfile fix.** This
  session did not touch them. Rebuild after hours and do not bake both at once.
- READONLY, COLLECTIONS_OFFICER and INSURANCE_OFFICER still have no client-document access. That
  needs Hein's decision; the PR body says the same.
- Pre-existing and out of scope: `getDocumentCaller` relies on session `tokenVersion` revocation
  and does not check `User.active`.
- The view modal fires two `/view` requests per open, which writes two access-log rows. This is
  pre-existing UI behaviour that was observed and not changed.
