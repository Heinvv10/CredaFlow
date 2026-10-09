/**
 * WCAG contrast of the CredaFlow palette, read from app/globals.css, with the
 * tenant colours at their defaults. The maths is lib/theme/contrast.ts.
 *
 *   npx tsx scripts/palette-contrast.ts      # prints the table, exits 1 on a failure
 *
 * scripts/__tests__/palette-contrast.test.ts runs the same check in the gate.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AA_TEXT, check } from "../lib/theme/contrast"

export { AA_TEXT, check, contrast, resolve, surfaces } from "../lib/theme/contrast"

if (process.argv[1]?.endsWith("palette-contrast.ts")) {
  const rows = check(readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8"))
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.surface.padEnd(5)} ${r.fg.padEnd(22)} on ${r.bg.padEnd(20)} ${r.ratio.toFixed(2)}:1`)
  const failed = rows.filter((r) => !r.pass).length
  console.log(`${rows.length} pairs, ${failed} below ${AA_TEXT}:1`)
  process.exit(failed ? 1 : 0)
}
