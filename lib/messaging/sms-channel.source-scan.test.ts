import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// lib/messaging/.claude.md: isSmsChannelEnabled() is the ONE wire. Two copies
// of the BULKSMS_DRY_RUN condition are two things that drift, and one of them
// failing OPEN was the F5 bug. Every SMS callsite asks the wire; only the wire
// (and the transport's own dry-run shim in bulksms.ts) may read the variable.
const ROOT = path.resolve(__dirname, "../..")
const ALLOWED = new Set(["lib/messaging/sms-channel.ts", "lib/integrations/bulksms.ts"])
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", "coverage", "docs"])

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* sources(full)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full
  }
}

describe("BULKSMS_DRY_RUN readers", () => {
  it("is read only by sms-channel.ts and bulksms.ts", () => {
    const readers: string[] = []
    for (const top of ["lib", "app", "components", "scripts", "prisma"]) {
      for (const file of sources(path.join(ROOT, top))) {
        if (/process\.env\.BULKSMS_DRY_RUN|env\[["']BULKSMS_DRY_RUN["']\]/.test(readFileSync(file, "utf8"))) {
          readers.push(path.relative(ROOT, file))
        }
      }
    }
    expect(readers.filter((f) => !ALLOWED.has(f))).toEqual([])
    expect(readers).toContain("lib/messaging/sms-channel.ts")
  })
})
