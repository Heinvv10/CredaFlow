/**
 * The guide's rows as the database will key them (ValuationGuideRow_key,
 * PostgreSQL lower()). The CSV reader folds case with JS toLowerCase, which
 * disagrees on a few letters (İ, final sigma), so the store re-checks the rows
 * here before it writes: a clash the reader missed is a refusal with line
 * reasons, never a unique violation. The lookups match with lower() as well
 * (./lookup.ts, ./revaluation-store.ts), so one fold decides everywhere.
 */
import { prisma } from "@/lib/prisma"
import { MAX_SHOWN_PROBLEMS } from "./csv"
import type { GuideProblem, GuideRow } from "./types"

export async function caseFoldClashes(rows: GuideRow[]): Promise<{ problems: GuideProblem[]; total: number }> {
  const clashes = await prisma.$queryRaw<{ line: number; first: number }[]>`
    SELECT k."line", k."first" FROM (
      SELECT r."line", min(r."line") OVER (PARTITION BY lower(r."make"), lower(r."model"), r."year", lower(r."variant")) AS "first"
      FROM unnest(${rows.map((r) => r.make)}::text[], ${rows.map((r) => r.model)}::text[], ${rows.map((r) => r.year)}::int[],
        ${rows.map((r) => r.variant)}::text[], ${rows.map((r) => r.lineNumber)}::int[]) AS r("make", "model", "year", "variant", "line")
    ) k WHERE k."line" <> k."first" ORDER BY k."line"`
  return {
    problems: clashes.slice(0, MAX_SHOWN_PROBLEMS).map((c) => ({
      line: Number(c.line), reason: `duplicates line ${Number(c.first)} when letter case is ignored (rows that differ only by letter case)`,
    })),
    total: clashes.length,
  }
}
