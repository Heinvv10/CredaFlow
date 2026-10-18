# Independent review register

Each reviewer was a fresh agent given the goal, the spec and the diff, never
the builder's reasoning. Fix deltas went back to the same reviewer until it
returned SHIP. "Read" = inspected source only; "ran" = executed code itself.

| Role | Model | Round 1 (db87ae79) | Round 2 (e6c3706b) | Round 3+ | Method |
|---|---|---|---|---|---|
| Code quality | sonnet | REQUEST_CHANGES (1 HIGH reused 403 Response; generic generate crash; NCA race 500; dead audit action; …) | SHIP | — | read |
| Security / policy-breaker | opus | SHIP (5 LOW) | SHIP (1 LOW: seeded approvals not marked → fixed, audit `via: "seed"`) | — | read |
| Tests | sonnet | REQUEST_CHANGES (variant coverage, route tests, matrix, loose regexes, …) | REQUEST_CHANGES (contract vs republication; deal-data mismatch) | SHIP | read; ran unit suites in round 1 |
| Architecture / absence | opus | REQUEST_CHANGES (HIGH demo-stack backfill; legacy NCA dead end; …) | REQUEST_CHANGES (MEDIUM legacy wet-ink confirm) | SHIP (1a68ba62) | read |
| South African legal / document | opus | REQUEST_CHANGES (H1 CPA s49 for lender terms; H2 override of protected clauses; M1–M5) | REQUEST_CHANGES (HIGH approval did not cover protected wording) | R3 REQUEST_CHANGES (fingerprint one shape) → R4 REQUEST_CHANGES (unreached branches) → R5 SHIP (4d00131d) | read; ran renders of all 11 variants (starter byte parity), validator probes, `fingerprint.test.ts` |
| Independent edge tester | opus | REQUEST_CHANGES (HIGH non-NCA finance lease unpreparable; validator bypasses; off-page text; 3 defence-in-depth) | REQUEST_CHANGES (quote gate used current flag; token headings; deny-list forms) | R3 (fingerprint coverage, quote dead end, audit row) → R4–R6 (unreached shapes) → R7 SHIP (cd6f83c5) | ran: own clone, own install, own disposable PG16 per DB round |

Committed independent repros (edge tester; authored in its clone, cherry-picked):
`lib/asset-finance/documents/templates/edge-validator.test.ts`,
`edge-templates.integration.test.ts`, `edge-round2-validator.test.ts`,
`edge-round3-fingerprint.test.ts`, `edge-round4-shapes.test.ts`,
`edge-round5-shapes.test.ts`, `edge-round6-shapes.test.ts`,
`lib/asset-finance/edge-round2-nca-quote.integration.test.ts`,
`lib/asset-finance/edge-round3-gates.integration.test.ts`. One case stays an
expected failure (`it.fails`): the starter lease typo "Lender base rate rate",
recorded for the drafters.

Needs the lender's legal sign-off (not code), per the legal reviewer's final
round: meaning of lender text on the commercial variants; clause 7.13's
exemption for 7.12 notices; documenting a commercial finance lease on the
instalment sale agreement; CPA s13 if 7.6 nominates an insurer; the starter
wording of every variant before any legal approval. Former DEFECT
tests were renamed FIXED once the fix landed; their adaptation to changed rules
was confirmed fair by the tester in the following round.

## Decisions taken from review (not code defects)

- Lender text only on commercial agreement variants (legal H1/H2/M2/M5).
- A legal approval is a lender SUPER_ADMIN's act with written sign-off
  confirmation and reference (legal M3, quality 2). The reference is a record,
  not verified evidence.
- Approvals bind a fingerprint of the protected output (legal round 2 HIGH).
- The word lists catch drafting, not meaning; the remainder is the approver's
  attestation and, for real lenders, the legal sign-off (legal H2 residual).

## Proof limits

- Lender-legal approval is not exercised against a real lender; all approvals
  in tests are labelled test fixtures, in browser acceptance synthetic demo.
- Portal e-signing of template documents is proven in real-PG tests, not in
  the browser run.
- The fingerprint covers the deal shapes listed in `preview.ts`; a protected
  branch no shape reaches is not bound to approvals until a shape is added.
