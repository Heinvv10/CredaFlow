import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { stripComments } from "@/lib/jurisdiction/strip-comments"

// The PASQ / credit-agreement / debit-mandate ceremony belongs to NCA_PASQ applications. A key-facts
// application is governed by app/api/applications/[id]/loan-documents, so every handler of every route in
// these directories must answer it with keyFactsRefusal() before doing any work (lib/non-nca-documents/refusal.ts).
// Structural, comments ignored: a route added under one of these directories without the call fails here.
const ROOT = path.resolve(__dirname, "..", "..", "app", "api", "applications", "[id]")
const CEREMONY_DIRS = ["pasq", "agreement", "debit-mandate", "signing-packet", "disburse"]
const HANDLER = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/gm

function routes(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...routes(full))
    else if (e.name === "route.ts") out.push(full)
  }
  return out
}

const files = CEREMONY_DIRS.flatMap((d) => routes(path.join(ROOT, d)))

describe("every PASQ / agreement / mandate / packet / disburse route refuses a key-facts application", () => {
  it("covers the ceremony routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(12)
  })

  it.each(files.map((f) => [path.relative(ROOT, f), f]))("%s", (_rel, file) => {
    const source = stripComments(fs.readFileSync(file, "utf8"))
    const starts = [...source.matchAll(HANDLER)].map((m) => ({ method: m[1], at: m.index ?? 0 }))
    expect(starts.length, "exports a handler").toBeGreaterThan(0)
    starts.forEach((start, i) => {
      const body = source.slice(start.at, starts[i + 1]?.at ?? source.length)
      expect(/await\s+keyFactsRefusal\(/.test(body), `${start.method} must await keyFactsRefusal(`).toBe(true)
    })
  })

  it("the disburse route asks for the disbursement answer, with the gate's own reason", () => {
    const disburse = stripComments(fs.readFileSync(path.join(ROOT, "disburse", "route.ts"), "utf8"))
    expect(disburse).toMatch(/keyFactsRefusal\(tenant\.id, id, "disburse"\)/)
  })
})
