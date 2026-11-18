# READONLY view-only documents — DONE, queued (2026-10-16 08:57 SAST)

Closes `.claude/handoffs/2026-10-16-readonly-documents-view-only-goal.md`.

## State
- **PR #126** `fix/readonly-documents-view-only` (worktree `../CredaFlow-readonly-docs`) — `mq add 126`, queued behind #124. Evidence in the PR body.
- Commits: 73e6bfb5 (change), d9522ca8 (drop dead catch, review LOW), a25d834f (merge origin/main).

## What shipped
- `lib/documents/write-access.ts`: `DOCUMENT_READ_ONLY_ROLES = ["READONLY"]`, `isDocumentReadOnlyRole`, `canWriteDocuments`, `refuseReadOnlyDocumentWrite` (audited 403, reason `document_write_read_only_role`).
- Gated first thing in the tenant handler: documents POST, selfie POST, [id]/sign, [id]/extract, **[id]/request-signature** (found by sweep; was `requireApiRole("READONLY")`).
- UI `readOnly` prop from the page's session role: DocumentsPanel/DocumentsTab, KycChecklistTab, SelfieKycTab.

## Success criteria
1–4 proven (unit + real PG + mutation + browser on a production build); 5 `ci:quality` + `ci:integration` green; 6 blind reviewer APPROVED→SHIP, breaker SHIP; 7 PR open + queued.

## Open for Hein (not done, not in scope)
- READONLY can still send client messages / comms notes (`clients/[id]/messages` POST, comms reply/note at `requireApiRole("READONLY")`). Decide whether "read-only" should cover those.
- `components/clients/KycDocumentsSection.tsx` looks dead (no importer).
- Browser screenshot of the KYC tab could not be captured (CDP timeout); evidence there is DOM text + button list.

## Next
- Confirm #126 merged (`mq` / `gh pr view 126`). Worktree `../CredaFlow-readonly-docs` can be removed after.
- KYC follow-ups goal still unstarted: `.claude/handoffs/2026-10-16-kyc-followups-goal.md`.
