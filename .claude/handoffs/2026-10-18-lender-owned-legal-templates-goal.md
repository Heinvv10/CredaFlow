# /goal — Lender-owned, versioned asset-finance legal templates

## Start a new session

Work in `/home/hein/Workspace/CredaFlow` and paste:

> /goal Execute .claude/handoffs/2026-10-18-lender-owned-legal-templates-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → independent Review → Fix loops. Do not stop to ask except at a Confirmation Gate (§8) or a genuine external blocker. Prove every Success Criterion (§7), open the PRs, merge through mq, write the handoff and authorized memory update, clean up your worktrees and branches, then stop.

This file prepares a future session; it does not start implementation in the
session that wrote it.

## §1 Mission and product decision

Each lender owns and approves its asset-finance document templates. CredaFlow
supplies usable starter wording and protected, system-generated deal content.
A lender can adopt a starter, edit the permitted wording, preview it with its
identity and a representative deal, and approve/publish an exact version.
Issued and executed documents retain the exact wording, populated data and PDF
that were presented; later template edits never rewrite existing documents.

Hein confirmed this is for demo purposes. Demonstrate the complete workflow
with synthetic lenders in an isolated local stack. Another agent is deploying;
coordinate ownership and do not modify that agent's deployment or runtime.
Demo acceptance is distinct from real-lender legal approval.

This is a new capability, not unfinished work from the previous26-gap goal.

## §2 Verified starting point — re-check live before building

The previous legal-code goal completed with all26 gaps closed, reviews/browser
acceptance and full CI green. Final main was
`e09956d5d4fcbc0c9d1d68a4f6ad9f8985e66b08`, tree identical to tested candidate
`cb0ae9d90f36c40dd77234eb94081a4302dfdc13`. PRs174/175/176/177 merged through MQ.
Read `2026-10-18-legal-code-gaps-completion.md`; preserve those financial and
legal enforcement rules and their regression evidence.

The shared checkout is dirty, with local main at93f28b01 when this was written.
Do not reset, stash, clean, pull into or overwrite that shared checkout or
`.claude/handoffs/LATEST.md`. Fetch current origin/main and use isolated worktrees
with their own `npm ci --legacy-peer-deps`. New upstream changes may exist.

Existing infrastructure to inspect and reuse:

- `prisma/schema/documents-signing.prisma`: tenant-owned DocumentTemplate and
  DocumentTemplateVersion, DRAFT/ACTIVE/ARCHIVED, approval and activation metadata.
- `app/api/documents/templates/`: list/create/edit/preview/version/approve/publish
  routes. Existing custom-template approval separates author and approver; when
  approval is required the approver cannot publish. Publishing locks the parent
  and activates/archives versions transactionally. Preserve existing duties.
- `app/(dashboard)/settings/documents/page.tsx` and `[id]/edit/page.tsx`:
  existing template management/editor. Extend these rather than create a rival UI.
- `lib/documents/{render,tokens,catalogue}.ts` and associated files: existing
  tenant token resolution, PDF generation and generatedFromVersionId provenance.
  Confirm actual paths/behavior on current main; names can drift.
- `prisma/seed-document-templates.ts` and the tenant-scoped model registry.
- `lib/asset-finance/documents/`: currently code-owned wording/renderers,
  tenant identity and assetFinanceLegalWordingApproved draft gating. The current
  tenant boolean is not approval of a specific template version.
- `lib/asset-finance/documents/wording/`, `docs/asset-finance/legal-wording/`,
  `docs/asset-finance/DESIGN.md` and the previous acceptance evidence.
- Existing signing, executed-document retention, hashes, document access logging,
  template sanitization/PDF sandboxing and audit infrastructure.

Read CLAUDE.md/AGENTS.md and applicable module rules. Query actual PostgreSQL
trigger and CHECK catalogs before changing enforcement, alongside migration SQL.
Do not infer database behavior from Prisma mocks.

## §3 Scope and required behavior

### 3.1 Specify the document inventory and protected structure first

Inventory every asset-finance agreement, quotation, notice, suretyship,
resolution and relevant annexure currently rendered. Record its document key,
contract/regime variant, render/serve/sign path, current approval gate and
provenance storage. Map every in-scope document to the new selection mechanism;
list any intentionally system-only document and explain the boundary.

Separate three responsibilities explicitly:

1. Lender identity/branding comes from its existing tenant identity/configuration.
2. Editable lender-authored wording and annexures belong to a versioned template.
3. Calculations, statutory disclosures, protected sections and financial schedules
   come from validated system data and trusted renderers.

Define the permitted editing schema, required tokens/sections and variant rules
before coding. Protect cross-references, numbering and regime-specific variants.
Do not allow an HTML/body override to omit protected disclosures, insert invented
financial values or claim unsupported contractual behavior. A calculation or
notice obligation is not configurable simply because its prose is editable.

Do not change consumer PASQ output/pins or rewrite the starter legal wording as
part of this task. New legal propositions require primary-source research and
appropriate sign-off; do not invent legal approval from an admin's demo action.

### 3.2 Tenant-owned starter adoption and authoring

Provide an idempotent, audited way for a lender to adopt the existing starter
wording as its own draft version. No other lender's version is selected or
copied implicitly. Upstream starter changes do not silently overwrite a lender's
customization. Preserve compatible existing generic templates and consumers.

Support editing and preview through the existing settings flow. Preview uses
the selected tenant/version and server-validated synthetic or authorized deal
data. Missing identity, required content or tokens must produce a clear refusal.
Choose the smallest extension compatible with existing rendering fidelity; a new
DOCX engine, arbitrary scripting system or wholesale editor replacement is out
of scope. Never expose raw implementation details as product decisions.

### 3.3 Approval and publication bind exact content

Approval must bind the exact version/content and intended document/regime scope.
Editing creates a new draft requiring fresh approval; an approved or issued
version cannot be silently edited in place. Preserve existing author/approver/
publisher separation, staff TOTP requirements and audited transitions.

Publish transactionally, with one eligible active version per tenant/document/
variant. Test concurrent edits, approvals and publications, stale approval,
republication and parent/version tenant mismatches. Put load-bearing invariants
in PostgreSQL where appropriate and exercise actual migrations.

Document the relationship with assetFinanceLegalWordingApproved. The old boolean
must not authorize newly edited wording or stand in for version approval. Do not
silently promote existing tenants or treat existing flags as proof of content
review. Use backward-compatible migration/default behavior; preserve historical
readability without permitting new unapproved execution.

Real lender sign-off and synthetic demo approval must remain distinguishable.
No change may let a demo fixture or environment setting grant real-lender legal
approval. Decide the minimum explicit representation in the spec and test it.

### 3.4 Issuance and signing freeze provenance

Route all in-scope generation through tenant/document/variant selection with
server-side approval gates. Draft preview and executable issuance are distinct.
Missing, stale, wrong-tenant or wrong-variant approval refuses execution without
falling back to a different lender or unapproved starter.

At the appropriate issuance/signing boundary, retain immutable provenance:
exact template/version/content hash, populated input snapshot sufficient for
reproduction, rendered PDF hash/bytes, tenant identity used and applicable
approval evidence. Reuse existing stores/models where possible. Define retention
and POPIA-sensitive input access carefully; do not duplicate personal data in logs.

New publication affects future issuance only. Existing issued/executed documents,
OTP challenges and signatures stay bound to the exact original bytes. A signing
session must not silently switch to a newly active version. Subsequent downloads
serve retained evidence rather than re-rendering against current settings.
Preserve wet-ink-only suretyships and all current signing/access/audit controls.

### 3.5 Demonstrate two synthetic lenders end to end

Using an isolated stack owned by this goal, seed two clearly synthetic lenders,
required staff roles/TOTP and representative asset-finance deals. Show different
permitted wording/branding for the same document family, without changing the
underlying calculations or protected content. Exercise applicable NCA,
commercial and CPA lease variants; do not infer all variants work from one lease.

Demonstrate adopt → edit → preview → independent approval → publish → issue,
then edit/publish a second version and show the original issued PDF unchanged.
Demonstrate refusal for self-approval, stale/wrong-tenant approval, missing
protected content and unapproved execution. If the legitimate execution flow
requires signing, use only synthetic local channels/test sinks and preserve
actual workflow restrictions. Do not invent a real legal approval to remove a
watermark. A demo indication must remain visible on synthetic outputs.

## §4 Execution and integration process

1. Collision check: worktrees, open PRs, current main and deployment ownership.
   Start in a clean isolated worktree; preserve unrelated work and runtime state.
2. Write a concise spec and rule-to-test matrix covering §3. Name the actual
   invariants, API/UI changes, schema/compatibility strategy and verification
   commands before implementation. Resolve routine choices autonomously.
3. Build TDD. Each risky gate gets a failing regression first; database rules
   require actual migrated PostgreSQL. Mutation-verify guards. Include tenant
   isolation, concurrency and historical-document tests, not just happy paths.
4. Run appropriate scoped checks, then complete npm run ci:full on every PR.
   Generate Prisma in each worktree and follow owned unique disposable PG16
   setup/check/migrate/teardown. Never share test ports/containers or change a
   migration already applied elsewhere. Keep baselines from growing.
5. Use fresh independent code, security, tests and South African legal/document
   reviewers, given instructions and diff rather than inherited conclusions.
   An independent edge tester works in its own clone and commits real repros.
   Assign clear file ownership and one integration writer; do not mutate shared
   runtime state in parallel. Review fix deltas until all return SHIP.
6. Review the actual current-main union. Prove tested-head/tree identity and
   ancestry. Publish reviewable PRs and merge only through mq; no direct merges.
   If stacked integration carries earlier PRs, verify each is genuinely merged
   and its reviewed head is reachable from main.
7. Keep the user updated on meaningful findings. Continue until §7 is proven;
   ask only at §8 or a genuine external blocker. Do not treat elapsed time or
   generic demo intent as permission for a gated action.

## §5 Acceptance and evidence

Commit a compact evidence directory, for example
`docs/asset-finance/evidence/lender-owned-templates/`, containing:

- Spec/inventory and invariant-to-test matrix, with any exclusion explained.
- Genuine red/green and mutation evidence, fresh PG results, concurrency results,
  full CI links and exact source identities. Failed runs stay labeled failures.
- Browser screenshots and concise steps/results for §3.5 using actual forms and
  password/TOTP sessions, including role/tenant denials and history retention.
- Extracted PDF text comparisons and render checks showing correct identity,
  protected sections and variants, different permitted lender wording and stable
  historical PDF bytes/hashes after new publication.
- Independent reviewer verdicts and committed tester repro references; identify
  what was inspected versus independently run, plus any explicit proof limits.

Do not commit secrets, real personal data, session cookies or simulated legal
approvals presented as real. Provider stubs/test sinks prove synthetic workflow
only; no real messages/payments are needed for this goal.

## §6 Documentation and handoff

Update architecture/module documentation to explain tenant template ownership,
protected content, version approvals, migration behavior, default selection and
immutable issuance/signing evidence. Update relevant drafter notes and DESIGN;
do not reopen or erase the completed26-gap legal acceptance. Regenerate AGENTS
mirrors only from canonical docs and run their gates.

Write a dated final handoff with PRs/merge SHAs, exact tested tree, CI/database/
browser/review evidence, compatibility boundaries, cleanup and remaining gated
external steps. Preserve dirty LATEST. This goal explicitly authorizes a memory
update about the completed capability, using the memory extension-note mechanism
required by the active session's instructions.

## §7 Success criteria — all must be proven

1. Inventory/spec covers every in-scope asset document and variant, with protected
   versus editable content and compatibility decisions explicit.
2. Two tenants can independently adopt/customize templates using the existing
   management flow; tests prove tenant isolation and no silent starter overwrite.
3. Protected disclosures/calculations/tokens cannot be bypassed through edit,
   preview, direct API, publication or issuance. Previous financial rules still pass.
4. Exact-version approval, fresh approval after edits, separation of duties,
   TOTP and audited transitions work; concurrency and raw-DB invariants are proven.
5. Wrong/missing/stale approval cannot authorize execution. Existing tenant flags
   cannot approve new content; demo approval cannot confer real-lender authority.
6. Each in-scope issued/executed document retains exact template/input/identity/
   approval/PDF provenance. Signing and downloads remain bound to original bytes
   after template or tenant identity changes; historical evidence stays readable.
7. Synthetic browser acceptance proves both lenders, representative NCA/CPA/
   commercial variants, negative gates and version-two/history preservation.
8. PDF/text/render checks pass; consumer PASQ/pins remain unchanged unless a
   separately approved §8 decision explicitly permits and proves a change.
9. All appropriate unit and real-PG tests plus complete ci:full pass on every PR;
   independent review roles and edge tester SHIP, with committed regressions.
10. PRs merged through mq; reviewed-head ancestry and final tested-tree identity
    verified against current main. Queue has no remaining goal entries.
11. Documentation, final handoff and authorized memory extension update written.
12. Goal-owned worktrees/branches/scratch stacks and DB containers/volumes cleaned;
    unrelated shared changes, deployment work and demo stacks preserved.

## §8 Confirmation gates — stop with a concrete reviewable proposal

Ask Hein before any of the following, unless explicitly approved in this session
for this exact scope; earlier goal migration approvals do not cover new work:

- Consumer NCA document repinning or consumer PASQ output changes; base mandated
  legal wording or signed-off calculation changes beyond this template capability.
- Destructive/non-additive migrations, historical evidence rewriting/deletion,
  or applying DDL to a shared database.
- Deployment/promotion, changing the other agent's runtime/deployment inputs,
  restoring/rebaking an existing demo/Fairscore stack, or production changes.
- Setting a real/shared lender's legal-approval flags or claiming real legal
  sign-off. Local, clearly synthetic version-approval fixtures are authorized;
  their design must not allow real-lender activation.
- Sending a real message, making a real payment, adding paid services or spend.

Before asking, finish the authorized implementation/spec and present the exact
change, affected constraints/artifacts, compatibility consequences and evidence.
No confirmation is required for routine reversible local work within this goal.
