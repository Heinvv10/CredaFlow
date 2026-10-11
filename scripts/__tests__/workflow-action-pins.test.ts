import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// A tag such as `@v4` can be moved to different code by whoever controls the
// action's repository; a full commit SHA cannot. Every `uses:` names a 40-hex
// commit and a `# vX.Y.Z` comment saying which release that commit is.
const dir = join(process.cwd(), ".github", "workflows")
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))

describe("GitHub Actions pins", () => {
  it("finds the workflows", () => {
    expect(workflows.length).toBeGreaterThan(0)
  })

  it.each(workflows)("%s pins every action to a full commit SHA", (name) => {
    const uses = readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => /^\s*(-\s+)?uses:/.test(line))
      .map((line) => line.trim())
    const unpinned = uses.filter((line) => !/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(line))
    expect(unpinned).toEqual([])
  })
})
