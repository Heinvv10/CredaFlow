import { describe, expect, it } from "vitest"
import { readPrismaSchema } from "./schema-source"

// Back-relation fields (a relation with no `fields:` — no column of its own)
// are where parallel PRs collide: each new model adds one line to Tenant,
// Client, Loan, User. Kept as one alphabetical block per model, two PRs adding
// different back-relations insert at different lines and merge cleanly.
const schema = readPrismaSchema()
const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]))

function backRelations(body: string): { name: string; line: number }[] {
  return body
    .split("\n")
    .map((text, line) => ({ text, line }))
    .flatMap(({ text, line }) => {
      // A trailing comment says nothing about the field; Prisma field definitions are one line.
      const m = text.replace(/\/\/.*$/, "").match(/^\s+(\w+)\s+(\w+)(\[\])?\??(\s.*)?$/)
      if (!m || !models.has(m[2]) || (m[4] ?? "").includes("fields:")) return []
      return [{ name: m[1], line }]
    })
}

const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b)

describe("prisma schema back-relations", () => {
  const blocks = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)].map((m) => ({ model: m[1], body: m[2] }))

  it("finds the models", () => {
    expect(blocks.length).toBe(models.size)
    expect(backRelations(blocks.find((b) => b.model === "Tenant")!.body).length).toBeGreaterThan(50)
  })

  it.each(blocks)("$model: back-relations are alphabetical, one per line, in one block", ({ body }) => {
    const rels = backRelations(body)
    const names = rels.map((r) => r.name)
    expect(names, "sort the model's back-relation fields alphabetically").toEqual([...names].sort(byName))
    const lines = body.split("\n")
    for (let i = 1; i < rels.length; i++) {
      const between = lines.slice(rels[i - 1].line + 1, rels[i].line)
      expect(
        between.every((l) => l.trim().startsWith("//")),
        `only comments may sit between back-relations ${rels[i - 1].name} and ${rels[i].name}`,
      ).toBe(true)
    }
  })
})
