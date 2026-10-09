import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { findOtherLender, OTHER_LENDER_DIGESTS, sha256 } from "@/lib/website/__fixtures__/other-lender"

/**
 * No lender's phone line may be hardcoded in application code.
 *
 * The lender's own WhatsApp number comes from `TenantConfig.publicWhatsapp`
 * (lib/config/identity.ts) and is passed to `waHref(e164, message)`
 * (lib/support/whatsapp-intents.ts); its voice line from `publicPhone`. A
 * `wa.me/<digits>` or `tel:` literal, or a bare constant holding a line, would
 * send one lender's customers to another's phone. This census checks the
 * forked lender's WhatsApp and voice lines, matched by digest
 * (lib/website/__fixtures__/other-lender.ts) so this file names neither; it
 * skips when the digests file outside the repository is absent.
 *
 * History: the WhatsApp number was once hardcoded in nine files, and a number
 * cutover left every copy pointing at a line the system no longer watched.
 * One file held a bare `const N = "<digits>"` interpolated later, which a
 * wa.me-only regex would have missed entirely.
 */
const ROOTS = ["lib", "app", "components", "scripts", "services"]

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      acc.push(full)
    }
  }
  return acc
}

const scan = (text: string, digests: readonly string[] = OTHER_LENDER_DIGESTS?.phone ?? []) => findOtherLender(text, digests).length > 0

describe("hardcoded phone lines", () => {
  // Without a planted offender a broken detector reads as a clean codebase —
  // mutating the original regex to something unmatchable left it green.
  it("the detector actually detects (positive control, synthetic line)", () => {
    const line = ["27115550100", "0115550100", "555 0100"].map(sha256)
    expect(scan('const n = "27115550100"', line)).toBe(true)
    expect(scan("https://wa.me/27115550100", line)).toBe(true)
    expect(scan("https://api.whatsapp.com/send?phone=27115550100", line)).toBe(true)
    expect(scan('"+27 11 555 0100"', line)).toBe(true)   // spaced/plus form
    expect(scan('href="tel:011 555 0100"', line)).toBe(true)
  })

  it("ignores other numbers and interpolated links", () => {
    expect(scan('placeholder="27821234567"')).toBe(false)
    expect(scan("const href = `https://wa.me/${e164}`")).toBe(false)
  })

  it.skipIf(!OTHER_LENDER_DIGESTS)("the forked lender's lines are never hardcoded", () => {
    const repoRoot = path.join(__dirname, "..", "..")
    const offenders = ROOTS.filter((r) => fs.existsSync(path.join(repoRoot, r)))
      .flatMap((r) => sourceFiles(path.join(repoRoot, r)))
      .map((f) => path.relative(repoRoot, f))
      .filter((rel) => scan(fs.readFileSync(path.join(repoRoot, rel), "utf8")))
      .sort()

    expect(
      offenders,
      "these files hardcode a forked-lender phone line. Read the lender's own " +
        "publicWhatsappE164 / publicPhone from lib/config/identity.ts.",
    ).toEqual([])
  }, 60_000)
})
