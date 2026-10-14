/**
 * npm run uploads:encrypt -- [--dir <uploads-dir>] [--dry-run | --verify]
 *
 * Reads UPLOADS_ENC_KEY. See scripts/encrypt-uploads.ts for what it does.
 * --verify changes nothing: it checks every encrypted file opens with the key.
 * Exit 0 done (or nothing to do), 1 any file failed or bad usage.
 */
import path from "node:path"
import { parseArgs } from "node:util"
import { uploadsMasterKey } from "../lib/storage-crypto"
import { encryptUploads, verifyUploads } from "./encrypt-uploads"

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
    },
    strict: true,
  })
  const master = uploadsMasterKey()
  if (!master) {
    process.stderr.write("UPLOADS_ENC_KEY is not set: nothing to encrypt or verify with\n")
    return 1
  }
  const dir = values.dir ?? path.join(process.cwd(), "uploads")

  if (values.verify) {
    const v = await verifyUploads(dir, master)
    process.stdout.write(`${dir}: ${v.opened} encrypted file(s) open with the key, ${v.plaintext} plaintext, ${v.failed.length} failed\n`)
    for (const f of v.failed) process.stderr.write(`FAILED ${f.file}: ${f.error}\n`)
    return v.failed.length > 0 ? 1 : 0
  }

  const dryRun = values["dry-run"] === true
  const r = await encryptUploads(dir, master, dryRun)
  const verb = dryRun ? "would encrypt" : "encrypted"
  process.stdout.write(
    `${dryRun ? "[dry run] " : ""}${dir}: ${verb} ${r.encrypted.length}, already encrypted ${r.alreadyEncrypted}, failed ${r.failed.length}, stale temp files removed ${r.staleTempsRemoved}\n`,
  )
  if (r.skippedEntries.length > 0) {
    process.stdout.write(`not entered (directories, dotfiles, special files): ${r.skippedEntries.join(", ")}\n`)
  }
  for (const f of r.failed) process.stderr.write(`FAILED ${f.file}: ${f.error}\n`)
  return r.failed.length > 0 ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`encrypt-uploads: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
