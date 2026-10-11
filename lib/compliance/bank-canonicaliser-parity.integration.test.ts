/**
 * The TypeScript bank canonicaliser and its Postgres twin must agree, value for
 * value. Run only against a disposable, fully migrated PostgreSQL:
 *
 *   RUN_BANK_CANONICAL_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/bank-canonicaliser-parity.integration.test.ts
 *
 * WHY THIS EXISTS
 *   `canonicalBankName` (lib/banks.ts) decides whether a payout is allowed in
 *   the ROUTE. `canonicalBankName` (Postgres) decides the same thing in
 *   the deferred trigger that fires at COMMIT. When the ACCOUNT-TYPE pair
 *   drifted, the route accepted a payout the trigger then rejected with 23514 —
 *   after both signatures were already recorded, which is the worst possible
 *   moment to discover a disagreement. No unit test can catch that: a mocked
 *   Prisma cannot execute a Postgres function.
 */
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { SA_BANKS, canonicalBankName } from "@/lib/banks"

const suite = process.env.RUN_BANK_CANONICAL_IT === "1" ? describe : describe.skip

/**
 * Every spelling either implementation must handle identically.
 *
 * The spellings are not illustrative — they are the distinct values the VLM
 * extracts from bank statements plus the spellings stored on client records. If the two
 * canonicalisers can disagree about any of them, a real consumer is affected.
 */
const SPELLINGS = [
  // --- the distinct VLM extractions ---
  "FNB", "Capitec Bank Limited", "NEDBANK", "Absa Bank Ltd",
  "Standard Bank", "Capitec Bank", "GoTyme Bank", "Discovery Bank",
  // --- the spellings stored on client records ---
  "First National Bank", "capitec", "CAPITEC", "ABSA", "TYME_BANK", "STANDARD_BANK",
  // --- registered names a statement prints instead of the brand ---
  "FIRSTRAND BANK LIMITED t/a FNB", "FirstRand Bank Limited",
  "The Standard Bank of South Africa Limited", "Nedbank Limited",
  "African Bank Limited", "Discovery Bank Limited", "Bidvest Bank Limited",
  "Investec Bank Limited", "TymeBank (Pty) Ltd",
  // --- the portal debit-mandate form's own labels ---
  "FNB (First National Bank)", "ABSA Bank", "Capitec Bank",
  // --- outside the vocabulary: both must fall through IDENTICALLY ---
  "Sasfin Bank", "Bank Zero", "Ithala", "",
  // --- punctuation, case and spacing must compact the same way ---
  "  f.n.b.  ", "A B S A", "capitec-bank", "STANDARD   BANK",
] as const

suite("bank canonicaliser parity: TypeScript vs Postgres", () => {
  it.each(SPELLINGS)("agrees on %j", async (value) => {
    const [row] = await prisma.$queryRaw<Array<{ canonical: string }>>`
      SELECT "canonicalBankName"(${value}) AS canonical
    `
    expect(row.canonical).toBe(canonicalBankName(value))
  })

  it("agrees on every label and code in the shared vocabulary", async () => {
    for (const bank of SA_BANKS) {
      for (const value of [bank.label, bank.code]) {
        const [row] = await prisma.$queryRaw<Array<{ canonical: string }>>`
          SELECT "canonicalBankName"(${value}) AS canonical
        `
        expect(row.canonical, `${bank.code} / ${value}`).toBe(canonicalBankName(value))
        expect(row.canonical, `${bank.code} / ${value}`).toBe(bank.canonical)
      }
    }
  })

  // The point of the FirstRand change: an FNB statement printed under the
  // registered name must reach the SAME canonical value as a client recorded
  // as FNB, in BOTH implementations, or the payout is refused.
  it("resolves FirstRand to FNB on both sides", async () => {
    const [row] = await prisma.$queryRaw<Array<{ canonical: string }>>`
      SELECT "canonicalBankName"('FIRSTRAND BANK LIMITED t/a FNB') AS canonical
    `
    expect(row.canonical).toBe("fnb")
    expect(canonicalBankName("FIRSTRAND BANK LIMITED t/a FNB")).toBe("fnb")
    expect(canonicalBankName("FNB")).toBe("fnb")
  })

  // NULL is not the empty string in SQL, and the trigger passes COALESCE(...,'')
  // — assert the function itself is null-safe rather than trusting its callers.
  it("handles NULL without diverging from the empty string", async () => {
    const [row] = await prisma.$queryRaw<Array<{ canonical: string }>>`
      SELECT "canonicalBankName"(NULL) AS canonical
    `
    expect(row.canonical).toBe("")
    expect(canonicalBankName("")).toBe("")
  })
})
