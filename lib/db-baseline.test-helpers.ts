/**
 * Read hand-written database objects out of the squashed baseline migration.
 *
 * The 179 inherited migrations were squashed into one baseline (white-label
 * plan, phase 5). Its hand-written section was generated from the catalog of
 * a database built with the old history, so each object appears once, in its
 * final form, as Postgres prints it: functions verbatim from
 * pg_get_functiondef (`$function$` delimiters), and constraints, triggers and
 * indexes as one normalised statement per line.
 *
 * Static tests read the SQL here. A rule that only holds when it runs belongs
 * in a RUN_*_IT integration test against a migrated database instead.
 */
import fs from "node:fs"
import path from "node:path"

export const BASELINE_MIGRATION_DIR = "20261009000000_baseline"

export const BASELINE_MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "prisma",
  "migrations",
  BASELINE_MIGRATION_DIR,
  "migration.sql",
)

let cached: string | undefined

export function readBaselineSql(): string {
  cached ??= fs.readFileSync(BASELINE_MIGRATION_PATH, "utf8")
  return cached
}

/** Every definition (one per overload) of public function `name`, joined. */
export function baselineFunctionSql(name: string): string {
  const header = new RegExp(
    `^CREATE OR REPLACE FUNCTION public\\.(?:"${escape(name)}"|${escape(name)})\\(`,
  )
  const lines = readBaselineSql().split("\n")
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue
    const end = lines.findIndex((l, j) => j > i && l === "$function$;")
    if (end === -1) throw new Error(`function ${name}: no closing $function$; in the baseline`)
    blocks.push(lines.slice(i, end + 1).join("\n"))
    i = end
  }
  if (blocks.length === 0) throw new Error(`function ${name} is not in the baseline`)
  return blocks.join("\n\n")
}

/** The one-line `ALTER TABLE … ADD CONSTRAINT "name" …;` statement. */
export function baselineConstraintSql(name: string): string {
  return oneLine(new RegExp(`^ALTER TABLE "[^"]+" ADD CONSTRAINT "${escape(name)}" `), `constraint ${name}`)
}

/** The one-line `CREATE [CONSTRAINT] TRIGGER "name" …;` statement. */
export function baselineTriggerSql(name: string): string {
  return oneLine(new RegExp(`^CREATE (?:CONSTRAINT )?TRIGGER "?${escape(name)}"? `), `trigger ${name}`)
}

/** The one-line `CREATE [UNIQUE] INDEX "name" …;` statement. */
export function baselineIndexSql(name: string): string {
  return oneLine(new RegExp(`^CREATE (?:UNIQUE )?INDEX "?${escape(name)}"? `), `index ${name}`)
}

function oneLine(re: RegExp, what: string): string {
  const hits = readBaselineSql().split("\n").filter((l) => re.test(l))
  if (hits.length !== 1) throw new Error(`${what}: expected 1 statement in the baseline, found ${hits.length}`)
  return hits[0]
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
