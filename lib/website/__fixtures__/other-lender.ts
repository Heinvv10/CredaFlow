import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"

/**
 * Guard against the identity of the lender CredaFlow was forked from coming
 * back into the tree (for example while porting a fix from that codebase).
 *
 * The identity is matched by SHA-256 digest, and the digests are NOT in the
 * repository: the old values are short (a brand word, registration numbers,
 * phone fragments, street names), so committed digests could be reversed by
 * guessing or enumeration. They live in a JSON file outside the repo —
 * `$CREDAFLOW_OTHER_LENDER_DIGESTS`, else
 * `~/.config/credaflow/other-lender-digests.json` — shaped as
 * `{ "<category>": ["<sha256 hex>", …] }`. Without the file the guard is off:
 * `expectNoOtherLender` passes and the whole-tree tests skip with a notice.
 *
 * A text matches when any window of 1, 2 or 3 consecutive tokens hashes to a
 * listed digest. Tokens are the text lowercased and split on every
 * non-alphanumeric character, joined back with one space — so "Foo-Bar",
 * "foo_bar" and "FOO BAR" are all the window "foo bar". HTML is scanned twice,
 * as written (attribute values) and with its tags removed (a phrase split by
 * markup, "<b>Foo</b> Bar"), and once more with identifiers split at camelCase
 * and letter/digit boundaries. Digit runs are also joined across spaces,
 * hyphens, parentheses and plus signs, and every 10- and 11-digit stretch is
 * matched, so a phone number is caught in any grouping. Each digest is
 * `sha256(window)` of one old value written in that form.
 */
export const OTHER_LENDER_DIGESTS_PATH =
  process.env.CREDAFLOW_OTHER_LENDER_DIGESTS || join(homedir(), ".config", "credaflow", "other-lender-digests.json")

function loadDigests(): Readonly<Record<string, readonly string[]>> | null {
  if (!existsSync(OTHER_LENDER_DIGESTS_PATH)) return null
  const parsed = JSON.parse(readFileSync(OTHER_LENDER_DIGESTS_PATH, "utf8")) as Record<string, string[]>
  for (const d of Object.values(parsed).flat()) {
    if (!/^[0-9a-f]{64}$/.test(d)) throw new Error(`${OTHER_LENDER_DIGESTS_PATH}: not a sha256 hex digest`)
  }
  return parsed
}

/** The digests by category, or null when the file is absent (guard off). */
export const OTHER_LENDER_DIGESTS = loadDigests()

let warned = false
function warnOff() {
  if (warned) return
  warned = true
  process.stderr.write(`[other-lender guard] OFF: no digests at ${OTHER_LENDER_DIGESTS_PATH}\n`)
}

const ALL_DIGESTS: readonly string[] = OTHER_LENDER_DIGESTS ? Object.values(OTHER_LENDER_DIGESTS).flat() : []

export const MAX_WINDOW = 3

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * The windows of `text` whose digest is in `digests`. Returns the matching
 * windows (from the text under test) so a failure says what leaked.
 */
// Whole-tree scans hash millions of windows; most recur. Bounded so a scan
// cannot grow it without limit.
const memo = new Map<string, string>()
function digest(w: string): string {
  let d = memo.get(w)
  if (d === undefined) {
    if (memo.size > 1_000_000) memo.clear()
    memo.set(w, (d = sha256(w)))
  }
  return d
}

export function findOtherLender(text: string, digests: readonly string[] = ALL_DIGESTS): string[] {
  const wanted = new Set(digests)
  const hits = new Set<string>()
  const stripped = text.replace(/<[^>]*>/g, " ")
  // Identifiers too: "fooBar2026" is also scanned as "foo Bar 2026".
  const split = stripped.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(?=\d)|(\d)(?=[A-Za-z])/g, "$1$2 ")
  for (const t of new Set([text, stripped, split])) {
    const toks = tokens(t)
    for (let i = 0; i < toks.length; i++) {
      for (let n = 1; n <= MAX_WINDOW && i + n <= toks.length; n++) {
        const w = toks.slice(i, i + n).join(" ")
        if (wanted.has(digest(w))) hits.add(w)
      }
    }
  }
  // Phone numbers in any grouping: digits joined across spaces, hyphens,
  // parentheses and plus signs, and every 10- and 11-digit run hashed.
  for (const m of stripped.matchAll(/\d[\d\s()+-]*\d/g)) {
    const digits = m[0].replace(/\D/g, "")
    for (const len of [10, 11]) {
      for (let i = 0; i + len <= digits.length; i++) {
        const w = digits.slice(i, i + len)
        if (wanted.has(digest(w))) hits.add(w)
      }
    }
  }
  return [...hits]
}

export function expectNoOtherLender(text: string) {
  if (!OTHER_LENDER_DIGESTS) return warnOff()
  expect(findOtherLender(text), "text names the forked lender").toEqual([])
}
