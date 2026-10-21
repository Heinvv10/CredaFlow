import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { findOtherLender, OTHER_LENDER_DIGESTS, OTHER_LENDER_DIGESTS_PATH } from "@/lib/website/__fixtures__/other-lender"

// CredaFlow began as a fork of another lender's system. Its identity (name,
// regulator numbers, office, phone lines, domains, hosts) was removed from
// every file; the NCA documents take a LenderIdentity and everything else
// reads lib/config/identity.ts. This stops any of it, or a copy of the old
// identity module, from quietly coming back. The values are matched by digest
// (lib/website/__fixtures__/other-lender.ts); the digests live outside the
// repository, and without them this check skips.

function git(...args: string[]): string[] {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean)
  } catch (e) {
    // git grep exits 1 when nothing matches; anything else (no repo, no git)
    // must fail the test rather than pass it vacuously.
    if ((e as { status?: number }).status === 1) return []
    throw e
  }
}

describe("forked lender identity boundary", () => {
  it.skipIf(!OTHER_LENDER_DIGESTS)(`no tracked or untracked file names the forked lender (digests: ${OTHER_LENDER_DIGESTS_PATH})`, () => {
    const files = git("ls-files", "--cached", "--others", "--exclude-standard")
    expect(files.length).toBeGreaterThan(1000)
    const offenders: string[] = []
    for (const f of files) {
      let buf: Buffer
      try { buf = readFileSync(f) } catch { continue } // deleted in the working tree
      const text = buf.includes(0) ? "" : buf.toString("utf8") // binaries: path only
      const hits = findOtherLender(`${f}\n${text}`)
      if (hits.length) offenders.push(`${f}: ${hits.join(", ")}`)
    }
    expect(offenders).toEqual([])
    // Not an import problem: ~5,900 files hashed window by window is ~20-30 s of
    // single-core CPU spread evenly over the tree (no hot file). A full parallel
    // run shares the cores with every other worker and took past 120 s.
  }, 300_000)

  it("the old per-topic constant modules are gone", () => {
    expect(git("grep", "--untracked", "-lE", "@/lib/config/(regulatory|company-contact|team)\"", "--", "*.ts", "*.tsx")).toEqual([])
  })
})
