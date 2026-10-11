/**
 * Read hand-written database objects out of the migrations.
 *
 * The 179 inherited migrations were squashed into one baseline (white-label
 * plan, phase 5). Its hand-written section was generated from the catalog of
 * a database built with the old history, so each object appears once, in its
 * final form, as Postgres prints it: functions verbatim from
 * pg_get_functiondef (`$function$` delimiters), and constraints, triggers and
 * indexes as one normalised statement per line. Later migrations that replace
 * or drop one of those objects write it in the same form.
 *
 * The `baseline*Sql` readers return an object's LATEST definition: the one in
 * the newest migration that defines it, or an error if that migration drops it.
 * `readBaselineSql` is the baseline file alone.
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

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations")

let cached: string | undefined

export function readBaselineSql(): string {
  cached ??= fs.readFileSync(BASELINE_MIGRATION_PATH, "utf8")
  return cached
}

let migrationsCache: Array<{ dir: string; lines: string[] }> | undefined

/** Every migration, newest first (Prisma applies them in name order). */
function migrationsNewestFirst(): Array<{ dir: string; lines: string[] }> {
  migrationsCache ??= fs.readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")))
    .sort()
    .reverse()
    .map((dir) => ({
      dir,
      lines: fs.readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8").split("\n"),
    }))
  return migrationsCache
}

/**
 * Every definition (one per overload) of public function `name` in the newest
 * migration that defines or drops it, joined.
 */
export function baselineFunctionSql(name: string): string {
  const fn = `public\\.(?:"${escape(name)}"|${escape(name)})\\(`
  const header = new RegExp(`^CREATE OR REPLACE FUNCTION ${fn}`)
  const drop = new RegExp(`^DROP FUNCTION (?:IF EXISTS )?${fn}`)
  for (const { dir, lines } of migrationsNewestFirst()) {
    const blocks: string[] = []
    let lastCreate = -1
    let lastDrop = -1
    for (let i = 0; i < lines.length; i++) {
      if (drop.test(lines[i])) lastDrop = i
      if (!header.test(lines[i])) continue
      const end = lines.findIndex((l, j) => j > i && l === "$function$;")
      if (end === -1) throw new Error(`function ${name}: no closing $function$; in ${dir}`)
      blocks.push(lines.slice(i, end + 1).join("\n"))
      lastCreate = i
      i = end
    }
    if (lastDrop > lastCreate) throw new Error(`function ${name} is dropped by ${dir}`)
    if (blocks.length > 0) return blocks.join("\n\n")
  }
  throw new Error(`function ${name} is not in any migration`)
}

/** The one-line `ALTER TABLE … ADD CONSTRAINT "name" …;` statement. */
export function baselineConstraintSql(name: string): string {
  return oneLine(
    new RegExp(`^ALTER TABLE "[^"]+" ADD CONSTRAINT "${escape(name)}" `),
    new RegExp(`^ALTER TABLE "[^"]+" DROP CONSTRAINT (?:IF EXISTS )?"${escape(name)}";`),
    `constraint ${name}`,
  )
}

/** The one-line `CREATE [CONSTRAINT] TRIGGER "name" …;` statement. */
export function baselineTriggerSql(name: string): string {
  return oneLine(
    new RegExp(`^CREATE (?:CONSTRAINT )?TRIGGER "?${escape(name)}"? `),
    new RegExp(`^DROP TRIGGER (?:IF EXISTS )?"?${escape(name)}"? `),
    `trigger ${name}`,
  )
}

/** The one-line `CREATE [UNIQUE] INDEX "name" …;` statement. */
export function baselineIndexSql(name: string): string {
  return oneLine(
    new RegExp(`^CREATE (?:UNIQUE )?INDEX "?${escape(name)}"? `),
    new RegExp(`^DROP INDEX (?:IF EXISTS )?"?${escape(name)}"?;`),
    `index ${name}`,
  )
}

/** The statement in the newest migration that creates or drops the object. */
function oneLine(create: RegExp, drop: RegExp, what: string): string {
  for (const { dir, lines } of migrationsNewestFirst()) {
    const hits = lines.flatMap((l, i) => (create.test(l) ? [i] : []))
    const lastDrop = lines.findLastIndex((l) => drop.test(l))
    if (hits.length > 1) throw new Error(`${what}: expected 1 statement in ${dir}, found ${hits.length}`)
    if (lastDrop > (hits[0] ?? -1)) throw new Error(`${what} is dropped by ${dir}`)
    if (hits.length === 1) return lines[hits[0]]
  }
  throw new Error(`${what}: expected 1 statement in the migrations, found 0`)
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
