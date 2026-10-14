/**
 * Builds the merchant list the categoriser's rules are written and measured
 * against (goal 2026-10-14 §6.1), from the off-repo statement corpus. Its
 * output never enters the repository.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/corpus MERCHANT_OUT_DIR=/secure/path/to/derived \
 *     npx tsx scripts/statement-merchant-keys.ts
 *
 * Every statement the TEXT readers read: each debit's description is reduced
 * with counterpartyKey() and digits masked to 9. A key is dropped when it
 * holds an "@", a run of six or more masked digits, or also appears as a
 * credit on an account that pays it (a person, not a merchant). Only keys
 * seen on at least MIN_HOLDERS distinct accounts are kept: merchants, not
 * people. An account is a salted hash of bank and account last 4 (the holder's
 * name is not used: a reader that misses it on one statement would make one
 * client two accounts); the salt is created once in MERCHANT_OUT_DIR and never
 * leaves it.
 *
 * Writes merchant-keys.tsv (`key \t row_count \t holder_count`) and its stable
 * ~60/40 split, merchant-keys.dev.tsv and merchant-keys.heldout.tsv. Prints
 * counts only.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { counterpartyKey } from "@/lib/credit-checks/undisclosed-debt"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"

const MIN_HOLDERS = 3
/** Share of keys in the dev set; the rest is held out for the blind labels. */
const DEV_SHARE = 60

export const maskKey = (description: string) => counterpartyKey(description).replace(/\d/g, "9")

/** Dev or held-out, from the key alone: the split never changes between runs. */
export function isDevKey(key: string): boolean {
  return parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 100 < DEV_SHARE
}

async function main() {
  const dir = process.env.STATEMENT_CORPUS_DIR
  const out = process.env.MERCHANT_OUT_DIR
  if (!dir || !out) throw new Error("set STATEMENT_CORPUS_DIR and MERCHANT_OUT_DIR")
  const saltPath = join(out, "holder-salt")
  if (!existsSync(saltPath)) writeFileSync(saltPath, randomBytes(32).toString("hex"), { mode: 0o600 })
  const salt = readFileSync(saltPath, "utf8")

  const rows = new Map<string, number>()
  const holders = new Map<string, Set<string>>()
  const creditedBy = new Map<string, Set<string>>()
  let read = 0
  for (const f of loadCorpus(dir).filter((f) => f.mimeType === "application/pdf")) {
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (!r?.read || r.method !== "TEXT") continue
    read++
    const account = createHash("sha256").update(`${salt}|${r.bank}|${r.read.accountNumberLast4 ?? f.id}`).digest("hex")
    for (const t of r.read.transactions) {
      if (t.nonPosting) continue
      const key = maskKey(t.description)
      if (!key) continue
      if (t.amountCents > 0) {
        creditedBy.set(key, (creditedBy.get(key) ?? new Set()).add(account))
        continue
      }
      rows.set(key, (rows.get(key) ?? 0) + 1)
      holders.set(key, (holders.get(key) ?? new Set()).add(account))
    }
  }

  const kept = [...rows].filter(([key]) => {
    if (key.includes("@") || /9{6,}/.test(key)) return false
    const credits = creditedBy.get(key)
    if (credits && [...holders.get(key)!].some((a) => credits.has(a))) return false
    return holders.get(key)!.size >= MIN_HOLDERS
  }).sort((a, b) => b[1] - a[1])

  const line = ([key, n]: [string, number]) => `${key}\t${n}\t${holders.get(key)!.size}`
  writeFileSync(join(out, "merchant-keys.tsv"), kept.map(line).join("\n") + "\n", { mode: 0o600 })
  writeFileSync(join(out, "merchant-keys.dev.tsv"), kept.filter(([k]) => isDevKey(k)).map(line).join("\n") + "\n", { mode: 0o600 })
  writeFileSync(join(out, "merchant-keys.heldout.tsv"), kept.filter(([k]) => !isDevKey(k)).map(line).join("\n") + "\n", { mode: 0o600 })
  const dev = kept.filter(([k]) => isDevKey(k))
  process.stdout.write(`statements read by text: ${read}\ndebit keys seen: ${rows.size}\nkept (>= ${MIN_HOLDERS} accounts): ${kept.length} ` +
    `(${kept.reduce((s, [, n]) => s + n, 0)} rows)\ndev: ${dev.length}, held out: ${kept.length - dev.length}\n`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`failed: ${err instanceof Error ? err.name : "unknown"}`)
    process.exit(1)
  })
}
