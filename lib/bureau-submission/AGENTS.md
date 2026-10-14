<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: bureau-submission
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Reports the loan book to Experian in SACRRA Layout 700v2 (monthly and daily
files). This is DATA SUBMISSION; the credit ENQUIRY (`lib/compliance/bureau.ts`,
`lib/integrations/`) is separate — leave it alone.

## Critical Rules
- **These lines land on real credit profiles and some cannot be undone by
  file.** A closure (C/T), write-off (W), handover (L) or deceased (Z) is sent
  ONCE. The ledger (`BureauSubmissionRecord`) is the record of what was sent;
  every later file is computed against its LIVE rows.
- **The once-only guard is a raw-SQL partial unique index** in the baseline
  migration (`BureauSubmissionRecord_live_once_only_status_key`), not schema.prisma.
  `prisma migrate dev` will offer to drop it. Do not let it.
- **Account number = `Loan.reference` upper-cased; `LN-` + a 25-char id loses
  the prefix** (`bureauAccountNumber`). That rule is FROZEN once a live file
  is sent. Branch code and sub-account are blank BY DESIGN: all three are the
  bureau's match key, so changing any later duplicates every account.
- **W and L need a `BureauAdverseConfirmation`.** Never emit either from loan
  status alone; never emit D, E or V.
- **Files are never written to disk.** A download re-renders from the `fields`
  snapshot (`render.ts`) and is refused unless it hashes to the stored sha256.
  Never re-render from live loan columns.
- **Month-end figures are only half as-at.** `recomputeLoanBalances` and
  `loanSettlementFigures` read `totalPaid` as stored NOW. A loan with a
  receipt, reversal, closure or write-off dated after the period is HELD, as
  is the book if charges were switched on/off after it; a status dated after
  it is left out. Later nightly charges do not hold a loan.
- **Two tiers** (`validate.ts`): a record rule holds one loan, a file rule
  blocks the file. A new rule needs a test that goes red without it.
- **A LIVE row means "the bureau was told".** Staff generation is always TEST
  and keeps only the newest TEST file's lines. Only `cron.ts` writes LIVE, and
  it REFUSES LIVE while `push.ts` has no transport: an undelivered LIVE file
  would use up closures that could then never be sent.
- **`push.ts` returns `NOT_CONFIGURED`.** Experian has not confirmed a channel;
  do not invent a transport. When push is built, a REJECTED submission must
  release its once-only statuses — nothing does that yet.
- **The consumer file never carries a loan with an `entityId`**, whatever its
  `ncaRegime` (`CONSUMER_BORROWER_WHERE` in `population.ts`; the asset-finance
  goal mandates it). Whether an NCA-classified entity loan must be reported,
  and in which file, is a slice-2 legal question: do not key this on the
  regime until it is answered.
- **No names, ID numbers or lines in logs, audit rows, bell items or error
  bodies.** Only a `BureauError` message may reach a caller or a cron body.
- **Unit tests cannot see the index or the population queries.** On a LOCAL
  database: `RUN_DB_IT=1 npx vitest run --no-file-parallelism
  lib/bureau-submission app/api/compliance/bureau-submissions`; none skipped.

## Layout
`layout.ts` fields · `map-loan.ts` loan → fields · `validate.ts` rules · `population.ts`
who is in a file · `prepare.ts` read-only · `generate.ts` ledger · `render.ts` re-render.
