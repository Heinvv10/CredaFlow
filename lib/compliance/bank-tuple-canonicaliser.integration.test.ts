/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_BANK_TUPLE_CANON_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/bank-tuple-canonicaliser.integration.test.ts
 *
 * WHAT THIS COVERS, and what it does NOT.
 *
 * `debit-mandate-bank-tuple-guard.test.ts` and `debit-mandate-product-names.test.ts`
 * assert against migration TEXT. That is worth having — it catches a label that
 * drifts between TypeScript and SQL — but it cannot tell you whether the
 * migration APPLIED, or whether the function Postgres actually holds behaves the
 * way the file says. CLAUDE.md is explicit about this failure mode: green unit
 * tests cannot see the database, and a mocked Prisma cannot execute a function,
 * a trigger or a CHECK constraint.
 *
 * So this suite executes the real functions against a real database, and pins
 * the exact inputs that once defeated the payout gate: a
 * Discovery Bank statement printing "Transaction Account", which the TypeScript
 * side accepted and the DB canonicaliser returned '' for.
 *
 * NOT COVERED, deliberately and stated rather than implied: this does not insert
 * a LoanApplication and drive it to DISBURSED, so it does not prove the trigger
 * FIRES correctly on a real row. Building that fixture is a larger piece of work
 * (see pasq-approval-guard-migration.integration.test.ts for the shape). The
 * remaining risk is narrow — the guard body is reproduced verbatim from the
 * migration it supersedes and the triggers are deliberately not recreated — but
 * it is real, and nobody should read this file as closing it.
 */
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { canonicalAccountType as tsCanonicalAccountType } from "./debit-mandate"
import { canonicalBankName as tsCanonicalBankName } from "@/lib/banks"

const suite = process.env.RUN_BANK_TUPLE_CANON_IT === "1" ? describe : describe.skip

async function canonicalAccountType(value: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ result: string }[]>`
    SELECT "canonicalAccountType"(${value}) AS result
  `
  return rows[0].result
}

async function canonicalBankName(value: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ result: string }[]>`
    SELECT "canonicalBankName"(${value}) AS result
  `
  return rows[0].result
}

suite("the DB account-type canonicaliser", () => {
  it("canonicalises Discovery's 'Transaction Account' to CHEQUE", async () => {
    // The exact string that blocked a signed R1 500 payout. The allow-list knew
    // 'transactional' and 'transactionalaccount' and matches EXACTLY, so the
    // singular form returned '' and could never equal client."accountType".
    expect(await canonicalAccountType("Transaction Account")).toBe("CHEQUE")
  })

  it.each([
    "TRANSACTION ACCOUNT",
    "transaction account",
    "Transaction  Account",
    "Transaction-Account",
  ])("is insensitive to case and punctuation: %s", async (printed) => {
    // The function strips every non-ASCII-letter and lowercases, so these are
    // the same input. The twins used to use DIFFERENT classes ([^a-z] after
    // lowercasing here, [^[:alpha:]] there); both now use
    // [^a-zA-Z], strip-then-lower. The suite below asserts that equality
    // directly rather than trusting it.
    expect(await canonicalAccountType(printed)).toBe("CHEQUE")
  })

  it.each([
    ["Cheque", "CHEQUE"],
    ["Current Account", "CHEQUE"],
    ["EASY ACCOUNT", "CHEQUE"],
    ["PRESTIGEACC", "CHEQUE"],
    ["Savings", "SAVINGS"],
    ["Savings Account", "SAVINGS"],
  ])("maps the known product %s to %s", async (printed, expected) => {
    expect(await canonicalAccountType(printed)).toBe(expected)
  })

  it.each([
    "Vitality Money Flexi Thing",
    "Transmission",
    "",
  ])("FAILS CLOSED on %s", async (printed) => {
    // An empty result can never equal a BankAccountType, so an unlearned product
    // is refused rather than matched against whatever is on file. Transmission
    // is included on purpose: it is retired, and it must stay unmatched.
    expect(await canonicalAccountType(printed)).toBe("")
  })
})

suite("the DB bank-name canonicaliser", () => {
  it.each([
    ["Discovery Bank", "discoverybank"],
    ["FIRSTRAND BANK LIMITED t/a FNB", "fnb"],
    ["First National Bank", "fnb"],
    ["Capitec Bank Limited", "capitec"],
  ])("canonicalises %s", async (printed, expected) => {
    expect(await canonicalBankName(printed)).toBe(expected)
  })
})

suite("the BankAccountType enum", () => {
  it("carries OTHER", async () => {
    // If the baseline migration has not applied, the app writing accountType='OTHER'
    // fails at the database with 22P02. Fail-closed, but a hard error for staff,
    // and a deploy gate that does NOT apply migrations leaves this assertion as
    // the thing that catches a half-applied deploy.
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'BankAccountType'
    `
    expect(rows.map((r) => r.enumlabel)).toContain("OTHER")
  })
})

suite("the DISBURSED bank-tuple guard, as Postgres actually holds it", () => {
  async function guardDefinition(): Promise<string> {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_functiondef(oid) AS def
      FROM pg_proc
      WHERE proname = 'guardLoanApplicationDebitMandateBankTupleRepair'
    `
    expect(rows).toHaveLength(1)
    return rows[0].def
  }

  it("no longer compares a branch code", async () => {
    // Read back from the live catalog rather than from the migration file, so a
    // migration that never applied cannot pass this.
    expect(await guardDefinition()).not.toContain("branchCode")
  })

  it("still binds the account number and the bank", async () => {
    const def = await guardDefinition()
    expect(def).toContain("bankAccountNumber")
    expect(def).toContain("canonicalBankName")
  })

  it("keeps its DEBIT_ORDER trigger scoping", async () => {
    // The guard is relaxed for EFT by being scoped away from it entirely. If a
    // migration ever recreates these triggers without the WHEN clause, the guard
    // silently starts applying to EFT disbursements, which have no signed
    // mandate and would fail at payout.
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname = 'LoanApplication'
        AND t.tgname LIKE '%bank_tuple%'
    `
    expect(rows.length).toBeGreaterThan(0)
    for (const { def } of rows) expect(def).toContain("DEBIT_ORDER")
  })
})

suite("TypeScript and Postgres canonicalisers agree on NORMALISATION", () => {
  // The existing parity test (`debit-mandate-product-names.test.ts`) compares
  // the LABEL LISTS on both sides. It cannot see the normalisation wrapped
  // around them, and that is where they diverged: JS `[^a-z]` dropped accented
  // letters while Postgres `[^[:alpha:]]` kept them, so "Savingsé" compacted to
  // `savings` in the route and stayed `savingsé` in the database — the route
  // accepted the payout and the DISBURSED trigger raised 23514 mid-transaction,
  // after both signatures were recorded. Both sides are ASCII-only in
  // the baseline migration; this suite is what keeps them that way.
  //
  // This runs the SAME input through BOTH implementations and requires the same
  // answer. It is a real comparison, not a fixture pinned to values someone
  // measured once and may have measured wrong.
  it.each([
    "Cheque",
    "Transaction Account",
    "TRANSACTION ACCOUNT",
    "Savings Account",
    "EASY ACCOUNT",
    "PRESTIGEACC",
    "Sav1ngs",
    "Vitality Money Flexi Thing",
    "",
    // Both Unicode forms of the same word. DIFFERENT byte sequences, and a VLM
    // may return either, so both must agree independently.
    "Chequ\u00e9",        // precomposed  é
    "Cheque\u0301",       // decomposed   e + combining acute
    "Savings\u00e9",
    // THESE are the inputs that matter. Everything above is Latin letters and
    // was covered by every attempted fix, so the corpus could not fail on the
    // residual gap. Each of these was measured DISAGREEING against a real PG16
    // while TypeScript used \p{L}: TS dropped the character and matched a
    // label, Postgres kept it and returned '' — the route accepts the payout
    // and the DISBURSED trigger raises 23514 after both signatures.
    "cheque\u0345",       // combining greek ypogegrammeni
    "EASY\u0345ACCOUNT",  // the same, inside a product prefix
    "Sav\u2160ings",      // ROMAN NUMERAL ONE: a NUMBER to Unicode, alpha to glibc
    "cheque\u0e34",       // thai vowel sign i
    "cheq\u05b0ue",       // hebrew point sheva
    "\u0130stanbul",      // capital I with dot
    // U+0130 IN FRONT OF A REAL LABEL. "İstanbul" alone does not discriminate:
    // both orderings produce a non-matching string, so the outcomes agree and
    // the assertion cannot fail. Here they do not — strip-then-lower yields
    // `cheque` and matches CHEQUE, while lower-then-strip yields `icheque`
    // (toLowerCase expands İ to i + combining dot) and matches nothing. That is
    // the ordering bug, made visible.
    "\u0130cheque",
  ])("agrees on %j", async (input) => {
    const sql = await canonicalAccountType(input)
    const ts = tsCanonicalAccountType(input) ?? ""
    expect(sql).toBe(ts)
  })
})

suite("TypeScript and Postgres BANK-NAME canonicalisers agree", () => {
  // Same class of bug as the account type, and less obvious because BOTH sides
  // of this comparison are canonicalised, which hides it for equal inputs. It
  // still breaks on unequal ones: "Bank " + U+00D8 and "Bank" compact to the
  // same string once a non-ASCII character is dropped, so TypeScript sees one
  // bank where Postgres sees two.
  it.each([
    "Discovery Bank",
    "FIRSTRAND BANK LIMITED t/a FNB",
    "Capitec Bank Limited",
    "Bank \u00d8",
    "Bank",
    "Nedbank\u0345",
    "\u0130nvestec",
    "ABSA 123",
  ])("agrees on %j", async (input) => {
    expect(await canonicalBankName(input)).toBe(tsCanonicalBankName(input))
  })
})
